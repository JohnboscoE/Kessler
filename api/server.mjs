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
  const { lockfile, compromised, includeDev = false, resultLimit = 500 } = request.body ?? {};

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

  // §10 error copy: name the package back to the user rather than failing vaguely.
  const known = await db.run(VERSION_EXISTS, { key: compromised });
  if (!firstValue(known)) {
    return reply.code(404).send({
      error: `${compromised} is not in the graph. Check the name.`,
      sources: parsed.versionIds.length,
    });
  }

  const startedAt = performance.now();
  const result = await db.run(
    blastRadius({
      sourceKeys: parsed.versionIds,
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
    sources: parsed.versionIds.length,
    packages: parsed.packages,
    devSkipped: parsed.devSkipped,
    exposedCount: exposed.size,
    maxDepth: MAX_DEPTH,
    elapsedMs,
    paths,
  };
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
 */
function normalizePaths(result) {
  return (result?.rows ?? [])
    .map((row) => decodePath(Array.isArray(row) ? row[0] : row))
    .filter(Boolean);
}

try {
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
