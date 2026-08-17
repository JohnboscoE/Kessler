/**
 * Stage 5 — load the JSONL into HydraDB.
 *
 * Two hard constraints, both verified against a running node on Aug 16 and
 * neither documented in KESSLER.md's original plan:
 *
 * 1. **Vertex ids are non-negative integers.** "UNWIND row 0 field id must be a
 *    non-negative integer". Kessler's model is keyed on strings throughout
 *    ("lodash@4.17.21"), so this stage assigns a dense integer id per entity and
 *    keeps the string on a `key` property. The mapping is written to
 *    data/out/idmap.json so the API can translate lockfile entries into the
 *    integer sources that algo.MSpaths needs.
 *
 * 2. **UNWIND batch forms are narrow** (cypher-compat.md). A vertex upsert must
 *    be `MERGE (n {id: row.id})` followed by `SET` — labels and properties
 *    cannot be folded into the MERGE pattern. Edges must MATCH two vertices by
 *    id then CREATE exactly one directed single-hop relationship, with nothing
 *    following the CREATE. The row list must come from a parameter; an inline
 *    literal list is rejected.
 *
 *   node ingest/load.mjs              load everything
 *   node ingest/load.mjs --benchmark  time batch sizes 100/500/1000 and stop
 */
import { HydraDB, HydraError } from '../api/hydradb.mjs';
import { readJsonl, outPath, exists, progress, writeJson } from './lib.mjs';

const BATCH = Number(process.env.KESSLER_BATCH ?? 1000);
/**
 * Per-query runtime limit. The server refuses anything above its own ceiling
 * with "rejected by admission control", and that ceiling defaults to 30s — too
 * short for edge batches once the graph passes ~100k edges. Raise it on the node
 * with GRAPH_MAX_QUERY_RUNTIME_MS (see README) or this stays capped at 30s and
 * relies entirely on batch halving.
 */
const TIMEOUT_MS = Number(process.env.KESSLER_QUERY_TIMEOUT_MS ?? 120_000);

/**
 * Write one batch, halving it on timeout.
 *
 * Edge batches MATCH two vertices per row, so they slow down as the graph fills.
 * A fixed batch size that works at 10k edges times out at 100k — this load died
 * exactly there. Rather than pick a conservative size that wastes time early,
 * the batch shrinks only when it has to and the load keeps going.
 */
async function writeBatch(db, query, rows) {
  if (!rows.length) return;
  try {
    await db.run(query, { rows }, { timeoutMs: TIMEOUT_MS });
  } catch (err) {
    // 408 = the query ran out of time. 429 with resource_exhausted = admission
    // control refused the runtime we asked for, which a smaller batch also fixes.
    const timedOut =
      err instanceof HydraError && (err.status === 408 || /resource_exhausted/.test(err.message));
    if (!timedOut || rows.length === 1) throw err;
    const mid = Math.ceil(rows.length / 2);
    await writeBatch(db, query, rows.slice(0, mid));
    await writeBatch(db, query, rows.slice(mid));
  }
}
const BENCHMARK = process.argv.includes('--benchmark');

const db = new HydraDB();

/**
 * Relationship identity counter.
 *
 * HydraDB shares one id space between vertices and relationships, so the bands
 * must not overlap. Three bands exist:
 *
 *   1 .. 9,999,999          bulk-loaded vertices (dense, assigned below)
 *   10,000,000 ..           bulk-loaded relationships (this counter)
 *   100,000,000 ..          on-demand ingest relationships (api/graph-writer.mjs)
 *
 * Getting this wrong silently corrupts adjacency rather than erroring — see the
 * note in graph-writer.mjs.
 */
let edgeIdCounter = 10_000_000;
const nextEdgeId = () => edgeIdCounter++;

async function main() {
  if (!(await db.healthy())) {
    console.error(`HydraDB unreachable at ${db.endpoint}`);
    console.error('start a node first — see KESSLER.md §5.2');
    process.exitCode = 1;
    return;
  }
  if (BENCHMARK) return benchmark();

  const startedAt = Date.now();
  const ids = await assignIds();
  console.log(`assigned ${ids.size.toLocaleString()} integer vertex ids`);

  let total = 0;
  total += await loadVertices('packages.jsonl', 'Package', ids, (row) => ({
    key: row.name,
    props: { name: row.name },
  }));
  total += await loadVertices('versions.jsonl', 'Version', ids, (row) => ({
    key: row.id,
    props: {
      name: row.name,
      version: row.version,
      published_at: row.published_at,
      deprecated: row.deprecated,
    },
  }));
  total += await loadVertices('maintainers.jsonl', 'Maintainer', ids, (row) => ({
    key: row.id,
    props: {},
  }));
  // Squat candidates are published packages nothing depends on, so they never
  // appeared in packages.jsonl and have no vertex yet.
  total += await loadVertices('similar_name.jsonl', 'Package', ids, (row) => ({
    key: row.to,
    props: { name: row.to },
  }));

  total += await loadEdges(
    'has_version.jsonl',
    'HAS_VERSION',
    ids,
    (row) => ({ from: row.package, to: row.version_id }),
    ['Package', 'Version']
  );
  total += await loadEdges(
    'maintains.jsonl',
    'MAINTAINS',
    ids,
    (row) => ({ from: row.maintainer, to: row.package }),
    ['Maintainer', 'Package']
  );
  // DECLARES is the largest edge set by far (~5.7 per version, so well over a
  // million rows at full scale) and **no §8 query reads it** — the human-readable
  // range the UI wants is already carried on RESOLVES_TO. Skipped by default;
  // set KESSLER_LOAD_DECLARES=1 to include it.
  if (process.env.KESSLER_LOAD_DECLARES === '1') {
    total += await loadEdges(
      'declares.jsonl',
      'DECLARES',
      ids,
      (row) => ({
        from: row.from,
        to: row.to,
        props: { range: row.range, dep_type: row.dep_type },
      }),
      ['Version', 'Package']
    );
  } else {
    console.log(`${'DECLARES'.padEnd(16)} skipped (set KESSLER_LOAD_DECLARES=1 to include)`);
  }
  total += await loadEdges(
    'resolves_to.jsonl',
    'RESOLVES_TO',
    ids,
    (row) => ({
      from: row.from,
      to: row.to,
      props: { range: row.range, dep_type: row.dep_type },
    }),
    ['Version', 'Version']
  );
  total += await loadEdges(
    'similar_name.jsonl',
    'SIMILAR_NAME',
    ids,
    (row) => ({
      from: row.from,
      to: row.to,
      props: {
        distance: row.distance,
        kind: row.kind,
        downloads: row.downloads,
        suspicion: row.suspicion,
      },
    }),
    ['Package', 'Package']
  );

  console.log('');
  console.log(
    `loaded ${total.toLocaleString()} rows in ${((Date.now() - startedAt) / 1000).toFixed(1)}s at batch ${BATCH}`
  );
  console.log('id map written to data/out/idmap.json');
}

/**
 * One dense integer per entity, assigned in a fixed file order so a reload
 * produces the same ids and the map stays comparable between runs.
 */
async function assignIds() {
  const ids = new Map();
  const take = (key) => {
    if (key !== undefined && key !== null && !ids.has(key)) ids.set(key, ids.size + 1);
  };

  for await (const row of rows('packages.jsonl')) take(row.name);
  for await (const row of rows('versions.jsonl')) take(row.id);
  for await (const row of rows('maintainers.jsonl')) take(row.id);
  for await (const row of rows('similar_name.jsonl')) take(row.to);

  await writeJson(outPath('idmap.json'), Object.fromEntries(ids));
  return ids;
}

async function* rows(file) {
  const full = outPath(file);
  if (!exists(full)) return;
  yield* readJsonl(full);
}

async function loadVertices(file, label, ids, shape) {
  const full = outPath(file);
  if (!exists(full)) {
    console.log(`${label.padEnd(16)} skipped (no ${file})`);
    return 0;
  }

  const setClause = ['n:' + label];
  let query = null;
  const report = progress(`${label} <- ${file}`.slice(0, 16).padEnd(16));
  const startedAt = Date.now();
  const seen = new Set();
  let batch = [];
  let written = 0;

  const flush = async () => {
    if (!batch.length) return;
    await writeBatch(db, query, batch);
    written += batch.length;
    batch = [];
    report(written);
  };

  for await (const row of readJsonl(full)) {
    const { key, props } = shape(row);
    const id = ids.get(key);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);

    if (!query) {
      const assignments = ['n.key = row.key', ...Object.keys(props).map((p) => `n.${p} = row.${p}`)];
      query = `UNWIND $rows AS row MERGE (n {id: row.id}) SET ${setClause.join(', ')}, ${assignments.join(', ')}`;
    }
    batch.push({ id, key, ...props });
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  const secs = (Date.now() - startedAt) / 1000;
  report(written, written, `${secs.toFixed(1)}s  ${rate(written, secs)} rows/s`);
  return written;
}

/**
 * `labels` is [fromLabel, toLabel] and is not optional: the parser rejects an
 * unlabelled endpoint with "UNWIND MATCH CREATE endpoints require exactly one
 * label". Exactly one — a bare `(a {id: ...})` and a doubly-labelled endpoint
 * are both refused.
 */
async function loadEdges(file, type, ids, shape, labels) {
  const full = outPath(file);
  if (!exists(full)) {
    console.log(`${type.padEnd(16)} skipped (no ${file})`);
    return 0;
  }
  const [fromLabel, toLabel] = labels;

  let query = null;
  const report = progress(type.padEnd(16));
  const startedAt = Date.now();
  let batch = [];
  let written = 0;
  let dangling = 0;

  const flush = async () => {
    if (!batch.length) return;
    await writeBatch(db, query, batch);
    written += batch.length;
    batch = [];
    report(written);
  };

  for await (const row of readJsonl(full)) {
    const { from, to, props = {} } = shape(row);
    const fromId = ids.get(from);
    const toId = ids.get(to);
    if (fromId === undefined || toId === undefined) {
      dangling += 1;
      continue;
    }

    // A relationship carrying properties needs its own integer identity —
    // "UNWIND relationship CREATE properties require id: row.<field>" — and it
    // must be the first property in the pattern. Relationship ids are allocated
    // from a counter that starts above every vertex id so the two spaces cannot
    // collide.
    const hasProps = Object.keys(props).length > 0;
    if (!query) {
      const keys = hasProps ? ['id', ...Object.keys(props)] : [];
      const propClause = keys.length
        ? ` {${keys.map((p) => `${p}: row.${p}`).join(', ')}}`
        : '';
      query = `UNWIND $rows AS row MATCH (a:${fromLabel} {id: row.from}), (b:${toLabel} {id: row.to}) CREATE (a)-[:${type}${propClause}]->(b)`;
    }
    batch.push({ from: fromId, to: toId, ...(hasProps ? { id: nextEdgeId() } : {}), ...props });
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  const secs = (Date.now() - startedAt) / 1000;
  const note = dangling ? `${secs.toFixed(1)}s  ${dangling} dangling skipped` : `${secs.toFixed(1)}s  ${rate(written, secs)} rows/s`;
  report(written, written, note);
  return written;
}

function rate(count, secs) {
  return secs > 0 ? Math.round(count / secs).toLocaleString() : String(count);
}

async function benchmark() {
  const file = outPath('versions.jsonl');
  if (!exists(file)) {
    console.error('no versions.jsonl — run the transform stage first');
    process.exitCode = 1;
    return;
  }

  const rowsOut = [];
  let n = 1_000_000;
  for await (const row of readJsonl(file)) {
    rowsOut.push({ id: n++, key: row.id, name: row.name });
    if (rowsOut.length >= 2000) break;
  }
  console.log(`benchmarking ${rowsOut.length} vertex upserts`);

  for (const size of [100, 500, 1000]) {
    const startedAt = Date.now();
    for (let i = 0; i < rowsOut.length; i += size) {
      await db.run(
        `UNWIND $rows AS row MERGE (n {id: row.id}) SET n:BenchVersion, n.key = row.key, n.name = row.name`,
        { rows: rowsOut.slice(i, i + size) }
      );
    }
    const secs = (Date.now() - startedAt) / 1000;
    console.log(`  batch ${String(size).padStart(4)}  ${secs.toFixed(2)}s  ${rate(rowsOut.length, secs)} rows/s`);
  }
}

await main();
