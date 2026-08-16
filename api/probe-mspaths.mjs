/**
 * Narrow probe for the one query the submission depends on.
 *
 * Two constraints discovered so far:
 *   - a list parameter cannot be passed into a procedure config map
 *     ("composite parameter is only supported as an UNWIND input"), so the
 *     values must be inlined as a literal;
 *   - "sourceValues must be a list of strings", so MSpaths resolves sources by a
 *     string property, not by integer vertex id. That is the `key` property the
 *     loader writes.
 */
import fs from 'node:fs/promises';
import { HydraDB } from './hydradb.mjs';

const db = new HydraDB();
const resolves = (await fs.readFile('data/out/resolves_to.jsonl', 'utf8'))
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

const inbound = new Map();
for (const row of resolves) inbound.set(row.to, (inbound.get(row.to) ?? 0) + 1);
const [targetKey] = [...inbound.entries()].sort((a, b) => b[1] - a[1])[0];

const direct = [...new Set(resolves.filter((r) => r.to === targetKey).map((r) => r.from))];
const sources = direct.slice(0, 40);

console.log(`target  ${targetKey}`);
console.log(`sources ${sources.length} with a known direct edge`);
console.log('');

async function attempt(label, query) {
  const startedAt = Date.now();
  try {
    const res = await db.run(query);
    const rows = res.rows ?? [];
    console.log(`✅ ${label} — ${Date.now() - startedAt}ms, ${rows.length} rows`);
    return rows;
  } catch (err) {
    console.log(`❌ ${label}`);
    console.log(`   ${err.message.slice(0, 200)}`);
    return null;
  }
}

const list = JSON.stringify(sources);
const target = JSON.stringify([targetKey]);

const rows = await attempt(
  'MSpaths by key, relDirection outgoing',
  `CALL algo.MSpaths({sourceLabel: 'Version', sourceProperty: 'key', sourceValues: ${list},
    targetLabel: 'Version', targetProperty: 'key', targetValues: ${target},
    pairwise: false, relTypes: ['RESOLVES_TO'], relDirection: 'outgoing',
    maxLen: 6, pathCount: 5, resultLimit: 200})
   YIELD path RETURN path`
);

await attempt(
  'MSpaths without targetLabel/targetProperty',
  `CALL algo.MSpaths({sourceLabel: 'Version', sourceProperty: 'key', sourceValues: ${list},
    targetValues: ${target}, pairwise: false, relTypes: ['RESOLVES_TO'],
    relDirection: 'outgoing', maxLen: 6, pathCount: 5, resultLimit: 200})
   YIELD path RETURN path`
);

if (rows?.length) {
  console.log('');
  console.log('--- decoded paths ---');
  for (const row of rows.slice(0, 6)) {
    const nodes = row[0]?.value?.nodes ?? [];
    const chain = nodes.map((n) => n.properties?.key?.String ?? n.id);
    console.log(`  depth ${chain.length - 1}: ${chain.join('  ->  ')}`);
  }
}
