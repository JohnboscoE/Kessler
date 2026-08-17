/**
 * Integrity check: do the edges in the graph match the lockfile they came from?
 *
 * Written because a blast-radius run produced paths that are provably false —
 * `uuid` has no dependencies at all, yet appeared mid-chain. A security tool that
 * invents dependency edges is worse than no tool, so this compares the graph
 * against ground truth rather than trusting it.
 */
import fs from 'node:fs/promises';
import { HydraDB, toObjects } from './hydradb.mjs';
import { buildLockfileGraph } from './lockfile-graph.mjs';
import { EDGE_KEY_PREFIX } from './graph-writer.mjs';

const db = new HydraDB();
const graph = buildLockfileGraph(await fs.readFile('fixtures/demo/package-lock.json', 'utf8'));

const expected = new Map();
for (const e of graph.edges) {
  if (!expected.has(e.from)) expected.set(e.from, new Set());
  expected.get(e.from).add(e.to);
}

const SAMPLE = ['uuid@10.0.0', 'text-hex@1.0.0', 'send@0.19.2', 'vary@1.1.2', 'form-data@4.0.6'];

console.log('key                     graph out-edges / lockfile out-edges');
console.log('-'.repeat(72));

const idmap = JSON.parse(await fs.readFile('data/out/idmap.json', 'utf8'));

let mismatched = 0;
for (const key of SAMPLE) {
  const id = idmap[key];
  if (id === undefined) {
    console.log(`${key.padEnd(22)} not in idmap`);
    continue;
  }
  // Match on the indexed id — matching on `key` forces a full scan and times out.
  const res = await db.run(
    'MATCH (a:Version { id: $id })-[:RESOLVES_TO]->(b:Version) RETURN b.key AS target',
    { id }
  );
  const inGraph = toObjects(res).map((r) => r.target).filter(Boolean).sort();
  const truth = [...(expected.get(key) ?? [])].sort();

  const spurious = inGraph.filter((t) => !truth.includes(t));
  const missing = truth.filter((t) => !inGraph.includes(t));
  if (spurious.length || missing.length) mismatched += 1;

  console.log(`${key.padEnd(22)} graph=${inGraph.length}  lockfile=${truth.length}`);
  if (spurious.length) console.log(`  SPURIOUS (${spurious.length}): ${spurious.slice(0, 8).join(', ')}`);
  if (missing.length) console.log(`  MISSING  (${missing.length}): ${missing.slice(0, 8).join(', ')}`);
}

console.log('');
console.log(mismatched ? `${mismatched}/${SAMPLE.length} sampled nodes disagree with the lockfile` : 'all sampled nodes match');

// Is the id mapping one-to-one? A collision would fuse two packages into one
// vertex and manufacture exactly this kind of false edge.
const raw = JSON.parse(await fs.readFile('data/out/idmap.json', 'utf8'));
const byId = new Map();
let collisions = 0;
for (const [key, id] of Object.entries(raw)) {
  if (key.startsWith(EDGE_KEY_PREFIX)) continue;
  if (byId.has(id)) {
    if (collisions < 10) console.log(`ID COLLISION ${id}: "${byId.get(id)}" and "${key}"`);
    collisions += 1;
  } else {
    byId.set(id, key);
  }
}
console.log('');
console.log(`idmap: ${byId.size} distinct vertex ids, ${collisions} collisions`);
