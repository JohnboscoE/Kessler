/**
 * Reports the shape of the built graph.
 *
 * Exists so the numbers in the README and on the page are read off the actual
 * data rather than remembered from an earlier run. KESSLER.md §13 requires an
 * honest statement of the graph's bounds; this is where those figures come from.
 */
import { readJsonl, outPath, exists, readJson } from './lib.mjs';
import { RAW_DIR } from './config.mjs';
import path from 'node:path';

const FILES = [
  'packages.jsonl',
  'versions.jsonl',
  'maintainers.jsonl',
  'has_version.jsonl',
  'maintains.jsonl',
  'declares.jsonl',
  'resolves_to.jsonl',
  'similar_name.jsonl',
];

async function main() {
  const manifestFile = path.join(RAW_DIR, '_manifest.json');
  if (exists(manifestFile)) {
    const manifest = await readJson(manifestFile);
    console.log(`crawled ${new Date(manifest.fetchedAt).toISOString()}`);
    console.log(`bounds  ${JSON.stringify(manifest.bounds)}`);
    const depths = {};
    for (const depth of Object.values(manifest.packages)) {
      depths[depth] = (depths[depth] ?? 0) + 1;
    }
    console.log(`seeds   ${manifest.seeds}`);
    console.log(`bfs     ${JSON.stringify(depths)}`);
    if (manifest.failures?.length) console.log(`failed  ${manifest.failures.length}`);
    console.log('');
  }

  let versionCount = 0;
  let deprecated = 0;
  let noTimestamp = 0;
  let earliest = Infinity;
  let latest = -Infinity;

  for (const file of FILES) {
    const full = outPath(file);
    if (!exists(full)) {
      console.log(`${file.padEnd(20)} —`);
      continue;
    }
    let count = 0;
    for await (const row of readJsonl(full)) {
      count += 1;
      if (file === 'versions.jsonl') {
        versionCount += 1;
        if (row.deprecated) deprecated += 1;
        if (row.published_at < 0) noTimestamp += 1;
        else {
          if (row.published_at < earliest) earliest = row.published_at;
          if (row.published_at > latest) latest = row.published_at;
        }
      }
    }
    console.log(`${file.padEnd(20)} ${count.toLocaleString()}`);
  }

  if (versionCount) {
    console.log('');
    console.log(`deprecated versions  ${deprecated.toLocaleString()}`);
    console.log(`without timestamp    ${noTimestamp.toLocaleString()}`);
    if (Number.isFinite(earliest)) {
      console.log(`publish range        ${iso(earliest)} .. ${iso(latest)}`);
    }
  }
}

function iso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

await main();
