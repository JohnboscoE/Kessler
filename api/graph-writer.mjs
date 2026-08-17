/**
 * On-demand ingest: merge an uploaded lockfile's subgraph into HydraDB.
 *
 * This is what turns Kessler from "does our crawl happen to cover you" into
 * "drop any lockfile and we answer over your graph". The lockfile already
 * carries a fully resolved tree (see lockfile-graph.mjs), so no registry calls
 * and no semver evaluation are needed — just id allocation and a batched write.
 *
 * Everything here is idempotent. Vertices MERGE on their integer id, and
 * relationships MERGE on their own allocated id, so re-uploading the same
 * lockfile updates in place instead of duplicating the graph.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Anchored to the repo root, never to process.cwd().
 *
 * `npm run api` starts the server from api/, so a cwd-relative path resolved to
 * api/data/out/idmap.json — a second, empty map. Allocation would then restart
 * at 1 and hand freshly ingested vertices ids that the bulk loader had already
 * given to different packages, silently corrupting adjacency in exactly the way
 * the id-band split above exists to prevent.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IDMAP_PATH =
  process.env.KESSLER_IDMAP ?? path.join(ROOT, 'data', 'out', 'idmap.json');
const BATCH = Number(process.env.KESSLER_BATCH ?? 1000);

/**
 * HydraDB shares one id space between vertices and relationships — its own docs
 * call a relationship's identity a `relationship_vertex`. The two counters must
 * therefore never be derived from a single maximum.
 *
 * An earlier version did exactly that, and once the first ingest persisted edge
 * ids, the next load started vertices and edges at the same number.
 * Relationships were handed ids belonging to vertices, corrupting adjacency and
 * producing dependency edges that do not exist — `uuid`, a package with no
 * dependencies at all, turned up mid-path. Hence the hard band split here and
 * `api/probe-integrity.mjs`, which checks the graph against lockfile truth.
 */
const EDGE_BASE = 100_000_000;
const EDGE_KEY_PREFIX = 'rel::';

export class IdAllocator {
  constructor(map = new Map(), nextVertex = 1, nextEdge = EDGE_BASE) {
    this.map = map;
    this.nextVertex = nextVertex;
    this.nextEdge = nextEdge;
    this.dirty = false;
  }

  static async load() {
    let map;
    try {
      map = new Map(Object.entries(JSON.parse(await fsp.readFile(IDMAP_PATH, 'utf8'))));
    } catch {
      return new IdAllocator();
    }

    // Each band's high-water mark comes only from its own band.
    let maxVertex = 0;
    let maxEdge = EDGE_BASE - 1;
    for (const [key, id] of map) {
      if (typeof id !== 'number') continue;
      if (key.startsWith(EDGE_KEY_PREFIX)) {
        if (id > maxEdge) maxEdge = id;
      } else if (id > maxVertex) {
        maxVertex = id;
      }
    }

    if (maxVertex >= EDGE_BASE) {
      throw new Error(
        `vertex id ${maxVertex} has run into the relationship band at ${EDGE_BASE}; ` +
          'rebuild the graph rather than allocating over it'
      );
    }
    return new IdAllocator(map, maxVertex + 1, maxEdge + 1);
  }

  /** Existing id for a key, or a freshly allocated one. */
  vertex(key) {
    const existing = this.map.get(key);
    if (existing !== undefined) return existing;
    const id = this.nextVertex++;
    if (id >= EDGE_BASE) throw new Error('vertex id space exhausted');
    this.map.set(key, id);
    this.dirty = true;
    return id;
  }

  has(key) {
    return this.map.has(key);
  }

  edge(from, to, type) {
    const key = `${EDGE_KEY_PREFIX}${type}:${from}->${to}`;
    const existing = this.map.get(key);
    if (existing !== undefined) return existing;
    const id = this.nextEdge++;
    this.map.set(key, id);
    this.dirty = true;
    return id;
  }

  async persist() {
    if (!this.dirty) return;
    await fsp.mkdir(path.dirname(IDMAP_PATH), { recursive: true });
    await fsp.writeFile(IDMAP_PATH, JSON.stringify(Object.fromEntries(this.map)), 'utf8');
    this.dirty = false;
  }
}

export { EDGE_BASE, EDGE_KEY_PREFIX };

export function idmapExists() {
  return fs.existsSync(IDMAP_PATH);
}

/**
 * Merge a lockfile subgraph into the database.
 */
export async function ingestLockfileGraph(db, graph, allocator) {
  const startedAt = Date.now();

  let alreadyPresent = 0;
  const versionRows = graph.versions.map((v) => {
    if (allocator.has(v.key)) alreadyPresent += 1;
    return {
      id: allocator.vertex(v.key),
      key: v.key,
      name: v.name,
      version: v.version,
    };
  });

  // Packages, so version nodes hang off something and the package-level §8
  // queries still work for anything the lockfile introduced.
  const packageRows = [...new Set(graph.versions.map((v) => v.name))].map((name) => ({
    id: allocator.vertex(name),
    key: name,
    name,
  }));

  const hasVersionRows = graph.versions.map((v) => ({
    id: allocator.edge(v.name, v.key, 'HAS_VERSION'),
    from: allocator.vertex(v.name),
    to: allocator.vertex(v.key),
  }));

  const edgeRows = graph.edges.map((e) => ({
    id: allocator.edge(e.from, e.to, 'RESOLVES_TO'),
    from: allocator.vertex(e.from),
    to: allocator.vertex(e.to),
    range: e.range ?? '',
    dep_type: e.dep_type ?? 'dependencies',
  }));

  await writeBatches(
    db,
    'UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Package, n.key = row.key, n.name = row.name',
    packageRows
  );
  await writeBatches(
    db,
    'UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Version, n.key = row.key, n.name = row.name, n.version = row.version',
    versionRows
  );
  await writeBatches(
    db,
    'UNWIND $rows AS row MATCH (a:Package {id: row.from}), (b:Version {id: row.to}) MERGE (a)-[r:HAS_VERSION {id: row.id}]->(b)',
    hasVersionRows
  );
  await writeBatches(
    db,
    'UNWIND $rows AS row MATCH (a:Version {id: row.from}), (b:Version {id: row.to}) MERGE (a)-[r:RESOLVES_TO {id: row.id}]->(b) SET r.range = row.range, r.dep_type = row.dep_type',
    edgeRows
  );

  await allocator.persist();

  return {
    versionsWritten: versionRows.length,
    packagesWritten: packageRows.length,
    edgesWritten: edgeRows.length,
    alreadyPresent,
    ms: Date.now() - startedAt,
  };
}

async function writeBatches(db, query, rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await db.run(query, { rows: rows.slice(i, i + BATCH) });
  }
}
