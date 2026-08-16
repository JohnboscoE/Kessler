/**
 * Verifies the §8 queries against a loaded graph.
 *
 * KESSLER.md §8 requires every query to be tested against the real parser before
 * any UI is built on it, and §3.2 wants the results recorded. This is that
 * harness — re-run it after any change to queries.mjs.
 *
 *   node api/probe-queries.mjs
 */
import fs from 'node:fs/promises';
import { HydraDB } from './hydradb.mjs';
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

const db = new HydraDB();

const resolves = (await fs.readFile('data/out/resolves_to.jsonl', 'utf8'))
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

const inbound = new Map();
for (const row of resolves) inbound.set(row.to, (inbound.get(row.to) ?? 0) + 1);
const [targetKey] = [...inbound.entries()].sort((a, b) => b[1] - a[1])[0];
const targetPkg = targetKey.slice(0, targetKey.lastIndexOf('@'));
const sourceKeys = [...new Set(resolves.map((r) => r.from))].slice(0, 120);

const squat = JSON.parse(
  (await fs.readFile('data/out/similar_name.jsonl', 'utf8')).trim().split('\n')[0]
);

console.log(`target  ${targetKey}`);
console.log(`sources ${sourceKeys.length}`);
console.log('');

const results = [];

async function probe(name, query, parameters = {}) {
  const startedAt = Date.now();
  try {
    const res = await db.run(query, parameters);
    const ms = Date.now() - startedAt;
    const rows = res.rows ?? [];
    console.log(`✅ ${name.padEnd(38)} ${String(ms).padStart(5)}ms  ${String(rows.length).padStart(4)} rows`);
    results.push({ name, ok: true, ms, rows: rows.length, res });
    return res;
  } catch (err) {
    console.log(`❌ ${name.padEnd(38)} ${err.message.slice(0, 150)}`);
    results.push({ name, ok: false, error: err.message });
    return null;
  }
}

await probe('coverage', GRAPH_COVERAGE);
await probe('version exists', VERSION_EXISTS, { key: targetKey });
await probe('vertex id for key', VERTEX_ID_FOR_KEY, { key: targetKey });

const q1 = await probe(
  'Q1 blast radius (algo.MSpaths)',
  blastRadius({ sourceKeys, targetKey, maxLen: 6, pathCount: 5, resultLimit: 300 })
);

const targetId = (await db.run(VERTEX_ID_FOR_KEY, { key: targetKey }))?.rows?.[0]?.[0]?.value;
const sourceId = (await db.run(VERTEX_ID_FOR_KEY, { key: sourceKeys[0] }))?.rows?.[0]?.[0]?.value;
await probe('naive single-source (algo.SPpaths)', BLAST_RADIUS_SINGLE_SOURCE, {
  sourceId,
  targetId,
  maxLen: 6,
  pathCount: 5,
});

await probe('Q2 introduction point', INTRODUCTION_POINT, {
  pkg: targetPkg,
  compromisedKey: targetKey,
});
await probe('Q3 live window', LIVE_WINDOW, {
  compromisedKey: targetKey,
  windowStart: 0,
  windowEnd: Date.now(),
});
await probe('Q4 maintainer overlap', MAINTAINER_OVERLAP, { pkg: targetPkg });
await probe('Q5 typosquat neighbourhood', TYPOSQUAT_NEIGHBOURHOOD, { pkg: squat.from });

if (q1?.rows?.length) {
  console.log('');
  console.log('--- sample blast-radius paths ---');
  const decoded = q1.rows.map((r) => decodePath(r[0])).filter(Boolean);
  const deepest = decoded.sort((a, b) => b.depth - a.depth).slice(0, 5);
  for (const p of deepest) console.log(`  depth ${p.depth}: ${p.nodes.join('  →  ')}`);
  console.log(`  ${decoded.length} paths decoded, max depth ${deepest[0]?.depth}`);
}

console.log('');
const ok = results.filter((r) => r.ok).length;
console.log(`${ok}/${results.length} query forms supported`);
for (const r of results.filter((x) => !x.ok)) console.log(`  FAILED ${r.name}`);
