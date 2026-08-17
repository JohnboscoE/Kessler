/**
 * Picks the compromised package that best demonstrates the product, by
 * measuring rather than guessing.
 *
 * "Best" is not the most-depended-on package. A target reachable from every
 * source at depth 1 proves nothing a grep could not. What demonstrates a blast
 * radius is depth *and* breadth: many distinct sources reaching it, by several
 * independent routes, several hops away.
 *
 *   node api/probe-target.mjs fixtures/demo/package-lock.json
 */
import fs from 'node:fs/promises';
import { HydraDB } from './hydradb.mjs';
import { buildLockfileGraph } from './lockfile-graph.mjs';
import { ingestLockfileGraph, IdAllocator } from './graph-writer.mjs';
import { blastRadius, decodePath } from './queries.mjs';

const file = process.argv[2] ?? 'fixtures/demo/package-lock.json';
const db = new HydraDB();

const raw = await fs.readFile(file, 'utf8');
const graph = buildLockfileGraph(raw);
const allocator = await IdAllocator.load();

console.log(`${file}: ${graph.stats.distinctVersions} versions, ${graph.stats.edges} edges`);
const ingested = await ingestLockfileGraph(db, graph, allocator);
console.log(`ingested in ${ingested.ms}ms (${ingested.alreadyPresent} already present)\n`);

const sourceKeys = graph.versions.map((v) => v.key);

// Candidates: anything something in this tree depends on. Ranked by inbound
// degree first so we probe the plausible ones.
const inbound = new Map();
for (const e of graph.edges) inbound.set(e.to, (inbound.get(e.to) ?? 0) + 1);
const candidates = [...inbound.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);

const scored = [];
for (const [targetKey] of candidates) {
  const res = await db.run(
    blastRadius({ sourceKeys, targetKey, maxLen: 6, pathCount: 5, resultLimit: 500 })
  );
  const seen = new Set();
  const paths = [];
  for (const row of res.rows ?? []) {
    const d = decodePath(row[0]);
    if (!d) continue;
    const sig = d.nodes.join('>');
    if (seen.has(sig)) continue;
    seen.add(sig);
    paths.push(d);
  }
  if (!paths.length) continue;

  const sources = new Set(paths.map((p) => p.nodes[0]));
  const maxDepth = paths.reduce((m, p) => Math.max(m, p.depth), 0);
  const deep = paths.filter((p) => p.depth >= 3).length;
  // Reward reach and depth together; a wide shallow hit is not interesting.
  const score = sources.size * (maxDepth + 1) + deep * 3;
  scored.push({ targetKey, paths: paths.length, sources: sources.size, maxDepth, deep, score, sample: paths.sort((a, b) => b.depth - a.depth)[0] });
}

scored.sort((a, b) => b.score - a.score);

console.log('target                          sources  paths  maxDepth  depth>=3  score');
console.log('-'.repeat(78));
for (const s of scored.slice(0, 12)) {
  console.log(
    `${s.targetKey.padEnd(30)} ${String(s.sources).padStart(7)} ${String(s.paths).padStart(6)} ${String(s.maxDepth).padStart(9)} ${String(s.deep).padStart(9)} ${String(s.score).padStart(6)}`
  );
}

const best = scored[0];
if (best) {
  console.log('');
  console.log(`recommended target: ${best.targetKey}`);
  console.log(`  ${best.sources} of ${sourceKeys.length} packages reach it, max depth ${best.maxDepth}`);
  console.log(`  deepest: ${best.sample.nodes.join('  →  ')}`);
}
