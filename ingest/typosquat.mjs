/**
 * Stage 4 — SIMILAR_NAME edges, registry-backed.
 *
 * The first version of this stage compared popular names against the packages in
 * our own graph and was structurally incapable of working: the crawl walks the
 * dependency closure of popular seeds, so every package in it is one that
 * something depends on, while a typosquat is by definition a package nobody
 * depends on. It produced one edge across 144,359 comparisons, and that edge was
 * a false positive.
 *
 * So the direction is inverted. For each popular package we *generate* the names
 * a human plausibly mistypes (see squat-names.mjs), ask the registry which of
 * them are actually published, and keep the ones that are. A published package
 * one keystroke from `lodash` that nobody has ever downloaded is the signal.
 *
 * Download counts are fetched for survivors and carried on the edge. They are
 * what separates `lodahs` (a squat) from `lodash-es` (a real project), and they
 * make the ratio explainable in the UI rather than asserted.
 */
import path from 'node:path';
import { RAW_DIR, REGISTRY, CONCURRENCY, SQUAT_TARGETS, SQUAT_MAX_RATIO } from './config.mjs';
import {
  ensureDirs,
  readJsonl,
  JsonlWriter,
  outPath,
  progress,
  exists as fileExists,
  readJson,
  writeJson,
} from './lib.mjs';
import { exists as nameExists, getJson, pool } from './http.mjs';
import { generateCandidates, flatten, stripScope } from './squat-names.mjs';

const DOWNLOADS_API = 'https://api.npmjs.org/downloads/point/last-week';
const NAME_CACHE = path.join(RAW_DIR, '_names.json');

const MAX_TARGETS = SQUAT_TARGETS;
// A squat is only interesting if the real package is worth impersonating, and
// only credible if the impostor is obscure. Anything above this share of the
// real package's traffic is treated as a legitimate sibling project.
const MAX_DOWNLOAD_RATIO = SQUAT_MAX_RATIO;

// Suffixes that mean "related project by convention", not "impostor".
const LEGITIMATE = [
  /^@types\//,
  /-(es|esm|cjs|native|core|cli|loader|plugin|preset|config|utils|polyfill|shim|next|legacy|compat|browser|node)$/,
  /^(eslint|babel|postcss|rollup|webpack|vite)-(config|plugin|preset|loader)-/,
];

async function main() {
  await ensureDirs();

  const packagesFile = outPath('packages.jsonl');
  if (!fileExists(packagesFile)) {
    console.error('missing data/out/packages.jsonl — run `npm run transform` first');
    process.exitCode = 1;
    return;
  }

  const startedAt = Date.now();

  const inGraph = new Set();
  for await (const row of readJsonl(packagesFile)) inGraph.add(row.name);

  const seeds = await readJson(new URL('./seeds.json', import.meta.url));
  const targets = [...new Set(seeds)].filter((n) => inGraph.has(n)).slice(0, MAX_TARGETS);

  // name -> { published, downloads } across runs. One file rather than thousands
  // of tiny ones; the scan issues tens of thousands of lookups and re-running it
  // must not re-ask the registry.
  const cache = fileExists(NAME_CACHE) ? await readJson(NAME_CACHE) : {};

  // ── generate ──────────────────────────────────────────────────────────────
  const candidates = new Map(); // candidate -> { target, kind }
  for (const target of targets) {
    for (const [candidate, kind] of generateCandidates(target)) {
      if (candidates.has(candidate)) continue;
      if (targets.includes(candidate)) continue;
      if (isLegitimateVariant(target, candidate)) continue;
      candidates.set(candidate, { target, kind });
    }
  }
  console.log(
    `generated ${candidates.size.toLocaleString()} candidate names from ${targets.length} packages`
  );

  // ── existence check ───────────────────────────────────────────────────────
  const toCheck = [...candidates.keys()].filter((n) => cache[n]?.published === undefined);
  const reportCheck = progress('existence');
  let checked = 0;
  let published = 0;

  await pool(toCheck, CONCURRENCY, async (name) => {
    try {
      const found = await nameExists(`${REGISTRY}/${name.replace(/\//g, '%2F')}`);
      cache[name] = { ...cache[name], published: found };
      if (found) published += 1;
    } catch (err) {
      // Leave unknown names uncached so a later run retries them, rather than
      // baking a transient failure in as "not published".
      cache[name] = { ...cache[name], error: String(err.message || err) };
    }
    checked += 1;
    reportCheck(checked, toCheck.length, `${published} published`);
  });
  reportCheck(toCheck.length, toCheck.length, `${published} published`);
  await writeJson(NAME_CACHE, cache);

  const live = [...candidates.keys()].filter((n) => cache[n]?.published);
  console.log(`${live.length.toLocaleString()} of them are actually published`);

  // ── downloads, for survivors and their targets ────────────────────────────
  const needDownloads = [...new Set([...live, ...targets])].filter(
    (n) => cache[n]?.downloads === undefined
  );
  const reportDl = progress('downloads');
  let fetched = 0;

  await pool(needDownloads, CONCURRENCY, async (name) => {
    try {
      const body = await getJson(`${DOWNLOADS_API}/${name.replace(/\//g, '%2F')}`);
      cache[name] = { ...cache[name], downloads: body?.downloads ?? 0 };
    } catch {
      cache[name] = { ...cache[name], downloads: 0 };
    }
    fetched += 1;
    reportDl(fetched, needDownloads.length);
  });
  reportDl(needDownloads.length, needDownloads.length);
  await writeJson(NAME_CACHE, cache);

  // ── classify and emit ─────────────────────────────────────────────────────
  const out = new JsonlWriter(outPath('similar_name.jsonl'));
  const dropped = { tooPopular: 0, legitimate: 0 };
  let emitted = 0;

  for (const candidate of live.sort()) {
    const { target, kind } = candidates.get(candidate);
    const candidateDownloads = cache[candidate]?.downloads ?? 0;
    const targetDownloads = cache[target]?.downloads ?? 0;

    if (isLegitimateVariant(target, candidate)) {
      dropped.legitimate += 1;
      continue;
    }

    const ratio = targetDownloads > 0 ? candidateDownloads / targetDownloads : 1;
    if (ratio > MAX_DOWNLOAD_RATIO) {
      dropped.tooPopular += 1;
      continue;
    }

    const backpressure = out.write({
      from: target,
      to: candidate,
      kind,
      distance: kind === 'separator' || kind === 'scope' ? 1 : editSize(target, candidate),
      downloads: candidateDownloads,
      target_downloads: targetDownloads,
      suspicion: gradeSuspicion(candidateDownloads),
      in_graph: inGraph.has(candidate),
    });
    if (backpressure) await backpressure;
    emitted += 1;
  }

  const count = await out.close();
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('');
  console.log(`typosquat complete in ${secs}s`);
  console.log(`  targets scanned      ${targets.length.toLocaleString()}`);
  console.log(`  candidates generated ${candidates.size.toLocaleString()}`);
  console.log(`  published            ${live.length.toLocaleString()}`);
  console.log(`  SIMILAR_NAME edges   ${count.toLocaleString()}`);
  console.log(`  dropped as legit     ${dropped.legitimate.toLocaleString()}`);
  console.log(
    `  dropped as popular   ${dropped.tooPopular.toLocaleString()} (>${MAX_DOWNLOAD_RATIO * 100}% of target traffic)`
  );
  void emitted;
}

function isLegitimateVariant(target, candidate) {
  if (flatten(target) === flatten(candidate)) return true;
  const bare = stripScope(candidate);
  const base = stripScope(target);
  for (const pattern of LEGITIMATE) {
    if (pattern.test(candidate) && (bare.startsWith(base) || base.startsWith(bare))) {
      return true;
    }
  }
  return false;
}

/** Cheap edit size for display; the generators only ever produce 1-2. */
function editSize(a, b) {
  return Math.abs(a.length - b.length) || 1;
}

/**
 * Traffic is genuinely ambiguous and should not be flattened into a boolean. A
 * name with no downloads is a parked squat. One with a few hundred is a squat
 * that is working — accidental installs are the point of the attack. One with
 * thousands is more likely a real project that happens to sit near a popular
 * name. The grade is reported so the UI can rank rather than assert.
 */
function gradeSuspicion(downloads) {
  if (downloads === 0) return 'high';
  if (downloads < 1000) return 'medium';
  return 'low';
}

await main();
