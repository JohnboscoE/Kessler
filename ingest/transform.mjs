/**
 * Stage 2 — packuments to normalised JSONL.
 *
 * Emits one file per node and edge type in KESSLER.md §7.2/§7.3. Deduplication
 * happens here rather than in the database: HydraDB's MERGE support is unproven
 * (§3.2) and plain CREATE over pre-deduplicated rows is both faster and one less
 * thing depending on an unverified feature. The JSONL files are the dedup
 * boundary.
 *
 * RESOLVES_TO is not produced here — it needs semver evaluation and gets its own
 * stage so the resolution strategy can be changed without re-running this one.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { RAW_DIR, ALL_DEP_TYPES } from './config.mjs';
import { ensureDirs, readJson, JsonlWriter, outPath, progress } from './lib.mjs';

async function main() {
  await ensureDirs();
  const startedAt = Date.now();

  const files = (await fsp.readdir(RAW_DIR)).filter(
    (f) => f.endsWith('.json') && !f.startsWith('_')
  );
  if (!files.length) {
    console.error('no packuments in data/raw — run `npm run fetch` first');
    process.exitCode = 1;
    return;
  }

  // Pass 1: which packages exist in the graph at all. DECLARES edges pointing
  // outside this set are dropped rather than creating version-less stub nodes —
  // dev dependencies are recorded but never expanded, so they routinely point
  // at packages deliberately not fetched.
  const known = new Set();
  for (const file of files) {
    const doc = await readJson(path.join(RAW_DIR, file));
    if (doc?.name) known.add(doc.name);
  }

  const packages = new JsonlWriter(outPath('packages.jsonl'));
  const versions = new JsonlWriter(outPath('versions.jsonl'));
  const maintainers = new JsonlWriter(outPath('maintainers.jsonl'));
  const hasVersion = new JsonlWriter(outPath('has_version.jsonl'));
  const maintains = new JsonlWriter(outPath('maintains.jsonl'));
  const declares = new JsonlWriter(outPath('declares.jsonl'));

  const seenMaintainers = new Set();
  const report = progress('transform');
  let processed = 0;
  let danglingDeclares = 0;
  let missingTimestamps = 0;

  for (const file of files) {
    const doc = await readJson(path.join(RAW_DIR, file));
    if (!doc?.name) continue;

    packages.write({ name: doc.name });

    for (const maintainer of doc.maintainers ?? []) {
      if (!seenMaintainers.has(maintainer)) {
        seenMaintainers.add(maintainer);
        maintainers.write({ id: maintainer });
      }
      maintains.write({ maintainer, package: doc.name });
    }

    for (const [version, entry] of Object.entries(doc.versions ?? {})) {
      const id = `${doc.name}@${version}`;
      const publishedAt = Date.parse(doc.time?.[version] ?? '');
      if (!Number.isFinite(publishedAt)) missingTimestamps += 1;

      versions.write({
        id,
        name: doc.name,
        version,
        // Epoch milliseconds as an integer — KESSLER.md §7.2 does not assume
        // date types are supported. -1 marks "registry reported no timestamp",
        // which is rare but real; the resolver treats it as unknown rather than
        // as the epoch.
        published_at: Number.isFinite(publishedAt) ? publishedAt : -1,
        deprecated: Boolean(entry.deprecated),
      });
      hasVersion.write({ package: doc.name, version_id: id });

      for (const depType of ALL_DEP_TYPES) {
        for (const [target, range] of Object.entries(entry[depType] ?? {})) {
          if (!known.has(target)) {
            danglingDeclares += 1;
            continue;
          }
          const backpressure = declares.write({ from: id, to: target, range, dep_type: depType });
          if (backpressure) await backpressure;
        }
      }
    }

    processed += 1;
    report(processed, files.length);
  }
  report(files.length, files.length);

  const counts = {
    packages: await packages.close(),
    versions: await versions.close(),
    maintainers: await maintainers.close(),
    has_version: await hasVersion.close(),
    maintains: await maintains.close(),
    declares: await declares.close(),
  };

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`transform complete in ${secs}s`);
  for (const [name, count] of Object.entries(counts)) {
    console.log(`  ${name.padEnd(14)} ${count.toLocaleString()}`);
  }
  console.log(
    `  dropped ${danglingDeclares.toLocaleString()} DECLARES edges pointing outside the graph`
  );
  if (missingTimestamps) {
    console.log(`  ${missingTimestamps} versions had no publish timestamp (published_at = -1)`);
  }
}

await main();
