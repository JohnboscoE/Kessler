/**
 * Why is the edge load so slow?
 *
 * Vertex upserts ran at ~4,600 rows/s. Edge writes ran at 170 rows/s on a
 * 6,659-vertex graph and 3 rows/s on an 86,024-vertex one — far worse than
 * linear, which is the signature of a per-row scan rather than an index lookup.
 *
 * Measures each candidate form instead of theorising about it.
 */
import fs from 'node:fs/promises';
import { HydraDB } from './hydradb.mjs';
import { readJsonl } from '../ingest/lib.mjs';

const db = new HydraDB();
const idmap = JSON.parse(await fs.readFile('data/out/idmap.json', 'utf8'));

// Real Version keys, straight from the file the loader used — not guessed by
// looking for '@', which also matches scoped package names.
const versionIds = [];
for await (const row of readJsonl('data/out/versions.jsonl')) {
  const id = idmap[row.id];
  if (typeof id === 'number') versionIds.push(id);
}
console.log(`sampled ${versionIds.length} genuine Version vertex ids\n`);

async function time(label, fn) {
  const startedAt = Date.now();
  try {
    const out = await fn();
    console.log(`${label.padEnd(50)} ${String(Date.now() - startedAt).padStart(7)}ms  ${out ?? ''}`);
    return Date.now() - startedAt;
  } catch (err) {
    console.log(`${label.padEnd(50)} FAILED`);
    console.log(`    ${err.message.slice(0, 260)}`);
    return null;
  }
}

const probeId = versionIds[100];

await time('MATCH (a {id}) RETURN a.key', async () => {
  const r = await db.run('MATCH (a {id: $id}) RETURN a.key AS k', { id: probeId }, { timeoutMs: 120000 });
  return `rows=${(r.rows ?? []).length}`;
});

await time('MATCH (a:Version {id}) RETURN a.key', async () => {
  const r = await db.run('MATCH (a:Version {id: $id}) RETURN a.key AS k', { id: probeId }, { timeoutMs: 120000 });
  return `rows=${(r.rows ?? []).length}`;
});

console.log('');

let edgeId = 900_000_000;
const makeRows = (n) =>
  Array.from({ length: n }, () => ({
    id: edgeId++,
    from: versionIds[Math.floor(Math.random() * versionIds.length)],
    to: versionIds[Math.floor(Math.random() * versionIds.length)],
  }));

for (const size of [100, 400, 1000]) {
  const rows = makeRows(size);
  const ms = await time(`UNWIND ${String(size).padStart(3)} edges, labelled endpoints`, async () => {
    await db.run(
      'UNWIND $rows AS row MATCH (a:Version {id: row.from}), (b:Version {id: row.to}) CREATE (a)-[:PERFTEST {id: row.id}]->(b)',
      { rows },
      { timeoutMs: 120000 }
    );
    return '';
  });
  if (ms) console.log(`${' '.repeat(50)}         ${Math.round(size / (ms / 1000))} rows/s`);
}

console.log('');
await time('UNWIND 400 vertex upserts (known-fast baseline)', async () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({ id: 800_000_000 + i, key: `perf-${i}` }));
  await db.run(
    'UNWIND $rows AS row MERGE (n {id: row.id}) SET n:PerfNode, n.key = row.key',
    { rows },
    { timeoutMs: 120000 }
  );
  return '';
});
