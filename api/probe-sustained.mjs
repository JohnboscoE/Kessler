/**
 * Does edge-write throughput hold up under sustained load, or collapse?
 *
 * Spot checks measured 79-107 rows/s, which implies ~35 minutes for the real
 * 224k-edge set. The actual load averaged 3.4 rows/s and took 18.6 hours. One of
 * those numbers is lying, and the difference matters: if throughput decays as
 * the store compacts, the fix is about write pressure; if it holds, the fix is
 * batch sizing.
 *
 * Writes consecutive batches into a throwaway relationship type and reports the
 * rate per batch so decay is visible rather than averaged away.
 */
import fs from 'node:fs/promises';
import { HydraDB } from './hydradb.mjs';
import { readJsonl } from '../ingest/lib.mjs';

const db = new HydraDB();
const BATCH = Number(process.env.PROBE_BATCH ?? 2000);
const ROUNDS = Number(process.env.PROBE_ROUNDS ?? 12);

const idmap = JSON.parse(await fs.readFile('data/out/idmap.json', 'utf8'));
const versionIds = [];
for await (const row of readJsonl('data/out/versions.jsonl')) {
  const id = idmap[row.id];
  if (typeof id === 'number') versionIds.push(id);
}

console.log(`${versionIds.length} vertices, batch ${BATCH}, ${ROUNDS} rounds\n`);
console.log('round      rows        ms    rows/s   cumulative rows/s');

let edgeId = 700_000_000;
let totalRows = 0;
let totalMs = 0;

for (let round = 1; round <= ROUNDS; round += 1) {
  const rows = Array.from({ length: BATCH }, () => ({
    id: edgeId++,
    from: versionIds[Math.floor(Math.random() * versionIds.length)],
    to: versionIds[Math.floor(Math.random() * versionIds.length)],
  }));

  const startedAt = Date.now();
  try {
    await db.run(
      'UNWIND $rows AS row MATCH (a:Version {id: row.from}), (b:Version {id: row.to}) CREATE (a)-[:SUSTAINED {id: row.id}]->(b)',
      { rows },
      { timeoutMs: 250_000 }
    );
  } catch (err) {
    console.log(`${String(round).padStart(5)}  FAILED  ${err.message.slice(0, 120)}`);
    break;
  }
  const ms = Date.now() - startedAt;
  totalRows += BATCH;
  totalMs += ms;

  console.log(
    `${String(round).padStart(5)} ${String(BATCH).padStart(9)} ${String(ms).padStart(9)} ${String(
      Math.round(BATCH / (ms / 1000))
    ).padStart(9)} ${String(Math.round(totalRows / (totalMs / 1000))).padStart(19)}`
  );
}

console.log('');
console.log(`overall ${Math.round(totalRows / (totalMs / 1000))} rows/s`);
console.log(`projected for 224,533 edges: ${(224533 / (totalRows / (totalMs / 1000)) / 60).toFixed(1)} min`);
