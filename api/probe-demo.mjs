/**
 * Finds a lockfile + compromised-package pair that actually demonstrates
 * something against the currently loaded graph.
 *
 * Answers two questions honestly rather than by guessing:
 *   1. which of a lockfile's resolved versions exist in the graph at all, and
 *   2. which targets those versions can actually reach.
 *
 *   node api/probe-demo.mjs [path/to/package-lock.json ...]
 */
import fs from 'node:fs/promises';
import { HydraDB } from './hydradb.mjs';
import { parseLockfile } from './lockfile.mjs';
import { blastRadius, VERSION_EXISTS, decodePath } from './queries.mjs';

const db = new HydraDB();
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['package-lock.json', 'web/package-lock.json', 'api/package-lock.json'];

for (const file of files) {
  console.log(`\n${'='.repeat(64)}\n${file}`);
  let parsed;
  try {
    parsed = parseLockfile(await fs.readFile(file, 'utf8'));
  } catch (err) {
    console.log(`  cannot read: ${err.message}`);
    continue;
  }

  console.log(`  ${parsed.versionIds.length} production versions, ${parsed.devSkipped} dev skipped`);

  const present = [];
  for (const key of parsed.versionIds) {
    const res = await db.run(VERSION_EXISTS, { key });
    if ((res.rows ?? []).length) present.push(key);
  }
  console.log(`  ${present.length} of ${parsed.versionIds.length} are in the graph`);
  if (present.length) console.log(`    ${present.slice(0, 8).join(', ')}`);
  const missing = parsed.versionIds.filter((k) => !present.includes(k));
  if (missing.length) console.log(`  missing: ${missing.slice(0, 8).join(', ')}`);

  if (!present.length) {
    console.log('  -> no usable sources; this lockfile cannot demo against this graph');
    continue;
  }

  // What can these sources actually reach? Walk outward and collect endpoints.
  const reach = new Map();
  const res = await db.run(
    blastRadius({ sourceKeys: present, targetKey: present[0], maxLen: 6, pathCount: 5, resultLimit: 5 })
  );
  void res;

  // MSpaths needs a target, so probe candidate targets drawn from the graph's
  // most depended-on versions.
  const resolves = (await fs.readFile('data/out/resolves_to.jsonl', 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const inbound = new Map();
  for (const row of resolves) inbound.set(row.to, (inbound.get(row.to) ?? 0) + 1);
  const candidates = [...inbound.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);

  for (const [targetKey] of candidates) {
    const out = await db.run(
      blastRadius({ sourceKeys: present, targetKey, maxLen: 6, pathCount: 5, resultLimit: 200 })
    );
    const paths = (out.rows ?? []).map((r) => decodePath(r[0])).filter(Boolean);
    if (paths.length) {
      const maxDepth = paths.reduce((m, p) => Math.max(m, p.depth), 0);
      reach.set(targetKey, { paths: paths.length, maxDepth, sample: paths.sort((a, b) => b.depth - a.depth)[0] });
    }
  }

  if (!reach.size) {
    console.log('  -> sources exist but reach none of the top targets within 6 hops');
    continue;
  }

  console.log('  reachable targets:');
  for (const [key, info] of [...reach.entries()].sort((a, b) => b[1].maxDepth - a[1].maxDepth)) {
    console.log(`    ${key.padEnd(28)} ${String(info.paths).padStart(4)} paths, max depth ${info.maxDepth}`);
    console.log(`      e.g. ${info.sample.nodes.join('  ->  ')}`);
  }
}
