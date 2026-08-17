/**
 * Kessler API — Fastify over the HydraDB HTTP interface.
 *
 * Deliberately thin. All the graph work happens in HydraDB (that is the point of
 * the submission); this layer parses lockfiles, holds the bearer token the
 * browser must never see, and shapes results for the UI.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { HydraDB, HydraError, toObjects } from './hydradb.mjs';
import { parseLockfile, LockfileError } from './lockfile.mjs';
import { buildLockfileGraph } from './lockfile-graph.mjs';
import { ingestLockfileGraph, IdAllocator } from './graph-writer.mjs';
import { INCIDENTS } from './incidents.mjs';
import {
  blastRadius,
  BLAST_RADIUS_SINGLE_SOURCE,
  INTRODUCTION_POINT,
  LIVE_WINDOW,
  MAINTAINER_OVERLAP,
  TYPOSQUAT_NEIGHBOURHOOD,
  VERSION_EXISTS,
  VERTEX_ID_FOR_KEY,
  GRAPH_COVERAGE,
  decodePath,
} from './queries.mjs';

// 8080 is a crowded default (IPFS claims it on this machine among others).
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const MAX_DEPTH = Number(process.env.KESSLER_MAX_DEPTH ?? 6);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
const db = new HydraDB();

await app.register(cors, {
  origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173').split(','),
});

app.get('/health', async () => {
  const reachable = await db.healthy();
  return {
    ok: reachable,
    hydradb: reachable ? 'reachable' : 'unreachable',
    endpoint: db.endpoint,
  };
});

app.get('/coverage', async () => {
  const result = await db.run(GRAPH_COVERAGE);
  return { packages: firstValue(result) ?? 0, maxDepth: MAX_DEPTH };
});

/**
 * The centrepiece. Every resolved version in the lockfile becomes a source and
 * the traversal runs once, server-side, rather than once per dependency.
 */
app.post('/scan', async (request, reply) => {
  const {
    lockfile,
    compromised,
    includeDev = false,
    resultLimit = 500,
    ingest = true,
  } = request.body ?? {};

  if (!compromised || typeof compromised !== 'string') {
    return reply.code(400).send({ error: 'compromised must be a "name@version" string' });
  }

  let parsed;
  try {
    parsed = parseLockfile(lockfile, { includeDev });
  } catch (err) {
    if (err instanceof LockfileError || err instanceof SyntaxError) {
      return reply.code(400).send({ error: `could not read lockfile: ${err.message}` });
    }
    throw err;
  }

  if (!parsed.versionIds.length) {
    return reply.code(400).send({ error: 'lockfile contained no resolved dependencies' });
  }

  // On-demand ingest. A lockfile is already a fully resolved graph, so an
  // uploaded one can be merged in directly — no registry calls, no semver work.
  // Without this, an arbitrary lockfile mostly misses our crawl and the honest
  // answer would be "not in the graph" rather than a result.
  let ingested = null;
  if (ingest) {
    try {
      const graph = buildLockfileGraph(lockfile, { includeDev });
      const allocator = await IdAllocator.load();
      ingested = await ingestLockfileGraph(db, graph, allocator);
    } catch (err) {
      // v1 lockfiles and malformed trees are not fatal — we can still answer
      // over whatever the crawl already covers, and we say so.
      request.log.warn({ err }, 'lockfile ingest skipped');
      ingested = { skipped: String(err.message ?? err) };
    }
  }

  // §10 error copy: name the package back to the user rather than failing vaguely.
  const known = await db.run(VERSION_EXISTS, { key: compromised });
  if (!firstValue(known)) {
    return reply.code(404).send({
      error: `${compromised} is not in the graph. Check the name.`,
      sources: parsed.versionIds.length,
    });
  }

  // Coverage: which of the user's versions the graph actually knows about.
  // Reporting this beats silently returning nothing — a partial answer the user
  // can interpret is far more useful than an empty one they cannot.
  const coverage = await measureCoverage(parsed.versionIds);

  // Only sources the graph actually contains are worth sending; unknown keys
  // cannot start a traversal and would just inflate the query.
  const sourceKeys = coverage.present.length ? coverage.present : parsed.versionIds;

  const startedAt = performance.now();
  const result = await db.run(
    blastRadius({
      sourceKeys,
      targetKey: compromised,
      maxLen: MAX_DEPTH,
      pathCount: 5,
      resultLimit,
    })
  );
  const elapsedMs = Math.round(performance.now() - startedAt);

  const paths = normalizePaths(result);
  const exposed = new Set(paths.map((p) => p.nodes[0]).filter(Boolean));

  return {
    compromised,
    sources: sourceKeys.length,
    packages: parsed.packages,
    devSkipped: parsed.devSkipped,
    exposedCount: exposed.size,
    maxDepth: MAX_DEPTH,
    elapsedMs,
    coverage: {
      total: parsed.versionIds.length,
      inGraph: coverage.present.length,
      missing: coverage.missing.slice(0, 20),
      missingCount: coverage.missing.length,
    },
    ingested,
    paths,
  };
});

/**
 * Which of these version keys exist as vertices. Done as one traversal-free
 * lookup per key: HydraDB has no `IN` over a list parameter, and a list cannot
 * be passed into a config map, so there is no batched form available.
 */
async function measureCoverage(keys) {
  const present = [];
  const missing = [];
  const checks = keys.map(async (key) => {
    const res = await db.run(VERSION_EXISTS, { key });
    if ((res.rows ?? []).length) present.push(key);
    else missing.push(key);
  });
  await Promise.all(checks);
  return { present, missing };
}

/**
 * Choke points: what in *this* lockfile would hurt most if it were compromised.
 *
 * Inverts the product's question. Instead of "package X was compromised, am I
 * exposed", this asks "nothing has happened yet — where is my worst latent
 * exposure". It is also the honest answer to "how do I know what to type": for
 * most people, most of the time, there is no advisory in hand.
 *
 * Ranking rewards reach and depth together. A package every dependency touches
 * at depth 1 is not interesting — a grep finds that. What matters is something
 * reached by many distinct sources along long chains, because that is what a
 * human auditor would never trace by hand.
 */
app.post('/chokepoints', async (request, reply) => {
  const { lockfile, includeDev = false, limit = 10, candidates = 30 } = request.body ?? {};

  let graph;
  try {
    graph = buildLockfileGraph(lockfile, { includeDev });
  } catch (err) {
    return reply.code(400).send({ error: `could not read lockfile: ${err.message}` });
  }
  if (!graph.versions.length) {
    return reply.code(400).send({ error: 'lockfile contained no resolved dependencies' });
  }

  const allocator = await IdAllocator.load();
  const ingested = await ingestLockfileGraph(db, graph, allocator);

  const inbound = new Map();
  for (const edge of graph.edges) inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
  const ranked = [...inbound.entries()].sort((a, b) => b[1] - a[1]).slice(0, candidates);

  const sourceKeys = graph.versions.map((v) => v.key);
  const scored = [];

  for (const [targetKey] of ranked) {
    const result = await db.run(
      blastRadius({ sourceKeys, targetKey, maxLen: MAX_DEPTH, pathCount: 5, resultLimit: 300 })
    );
    const paths = normalizePaths(result);
    if (!paths.length) continue;

    const sources = new Set(paths.map((p) => p.nodes[0]));
    const maxDepth = paths.reduce((m, p) => Math.max(m, p.depth), 0);
    const deep = paths.filter((p) => p.depth >= 3).length;

    scored.push({
      target: targetKey,
      reachedBy: sources.size,
      paths: paths.length,
      maxDepth,
      deepPaths: deep,
      score: sources.size * (maxDepth + 1) + deep * 3,
      deepest: paths[0] ?? null,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  return {
    totalVersions: graph.versions.length,
    ingested,
    chokepoints: scored.slice(0, limit),
  };
});

/** Documented real-world compromises, filtered to those this graph can answer for. */
app.get('/incidents', async () => {
  const checked = await Promise.all(
    INCIDENTS.map(async (incident) => {
      const key = `${incident.pkg}@${incident.version}`;
      const res = await db.run(VERSION_EXISTS, { key });
      return { ...incident, key, inGraph: (res.rows ?? []).length > 0 };
    })
  );
  return { incidents: checked };
});

app.get('/introduction', async (request, reply) => {
  const { pkg, compromised } = request.query ?? {};
  if (!pkg || !compromised) {
    return reply.code(400).send({ error: 'pkg and compromised are required' });
  }
  const result = await db.run(INTRODUCTION_POINT, { pkg, compromisedKey: compromised });
  return { pkg, compromised, rows: rowsOf(result) };
});

app.get('/live-window', async (request, reply) => {
  const { compromised, start, end } = request.query ?? {};
  if (!compromised) return reply.code(400).send({ error: 'compromised is required' });
  const result = await db.run(LIVE_WINDOW, {
    compromisedKey: compromised,
    windowStart: Number(start ?? 0),
    windowEnd: Number(end ?? Date.now()),
  });
  return { compromised, rows: rowsOf(result) };
});

app.get('/maintainers', async (request, reply) => {
  const { pkg } = request.query ?? {};
  if (!pkg) return reply.code(400).send({ error: 'pkg is required' });
  const result = await db.run(MAINTAINER_OVERLAP, { pkg });
  return { pkg, rows: rowsOf(result) };
});

app.get('/typosquats', async (request, reply) => {
  const { pkg } = request.query ?? {};
  if (!pkg) return reply.code(400).send({ error: 'pkg is required' });
  const result = await db.run(TYPOSQUAT_NEIGHBOURHOOD, { pkg });
  return { pkg, rows: rowsOf(result) };
});

/**
 * The §13 video argument, measured rather than claimed: one many-source
 * traversal against the naive one-call-per-source loop over the same graph.
 */
app.post('/benchmark', async (request, reply) => {
  const { lockfile, compromised, includeDev = false, sampleSize = 25 } = request.body ?? {};
  if (!compromised) return reply.code(400).send({ error: 'compromised is required' });

  let parsed;
  try {
    parsed = parseLockfile(lockfile, { includeDev });
  } catch (err) {
    return reply.code(400).send({ error: `could not read lockfile: ${err.message}` });
  }

  const batchStart = performance.now();
  await db.run(
    blastRadius({
      sourceKeys: parsed.versionIds,
      targetKey: compromised,
      maxLen: MAX_DEPTH,
      pathCount: 5,
      resultLimit: 500,
    })
  );
  const batchMs = Math.round(performance.now() - batchStart);

  // SPpaths takes integer vertex ids, so the naive path pays a lookup per source
  // as well — which is itself part of the honest comparison.
  const targetId = firstValue(await db.run(VERTEX_ID_FOR_KEY, { key: compromised }));
  const sample = parsed.versionIds.slice(0, sampleSize);
  const naiveStart = performance.now();
  for (const key of sample) {
    const sourceId = firstValue(await db.run(VERTEX_ID_FOR_KEY, { key }));
    if (sourceId === undefined || targetId === undefined) continue;
    await db.run(BLAST_RADIUS_SINGLE_SOURCE, {
      sourceId,
      targetId,
      maxLen: MAX_DEPTH,
      pathCount: 5,
    });
  }
  const naiveMs = Math.round(performance.now() - naiveStart);
  const projectedMs = Math.round((naiveMs / Math.max(sample.length, 1)) * parsed.versionIds.length);

  return {
    sources: parsed.versionIds.length,
    batch: { calls: 1, ms: batchMs },
    naive: { sampled: sample.length, ms: naiveMs, projectedFullMs: projectedMs },
    speedup: batchMs > 0 ? Number((projectedMs / batchMs).toFixed(1)) : null,
  };
});

app.setErrorHandler((err, _request, reply) => {
  if (err instanceof HydraError) {
    app.log.error({ err }, 'hydradb call failed');
    return reply.code(502).send({ error: err.message });
  }
  app.log.error({ err }, 'unhandled');
  return reply.code(500).send({ error: 'internal error' });
});

/**
 * Result shaping.
 *
 * The exact JSON shape of `YIELD path` is not documented and has not yet been
 * observed against a running node — Gate 0 is not cleared. These readers are
 * deliberately tolerant and must be checked against real output before the UI is
 * built on top of them. See KESSLER.md §3.2.
 */
function rowsOf(result) {
  return toObjects(result);
}

function firstValue(result) {
  const [row] = rowsOf(result);
  if (!row) return undefined;
  return Object.values(row)[0];
}

/**
 * Path rows arrive as raw tagged cells, not through toObjects — the decoder
 * needs the tag and the typed node properties that unwrapping would discard.
 *
 * Deduplicated by node chain. The bulk loader writes RESOLVES_TO with CREATE
 * while on-demand ingest uses MERGE, so a package present in both the crawl and
 * an uploaded lockfile can carry the same logical edge twice and the traversal
 * will faithfully return the same chain more than once.
 */
function normalizePaths(result) {
  const seen = new Set();
  const paths = [];
  for (const row of result?.rows ?? []) {
    const decoded = decodePath(Array.isArray(row) ? row[0] : row);
    if (!decoded) continue;
    const signature = decoded.nodes.join('>');
    if (seen.has(signature)) continue;
    seen.add(signature);
    paths.push(decoded);
  }
  return paths.sort((a, b) => b.depth - a.depth);
}

try {
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
