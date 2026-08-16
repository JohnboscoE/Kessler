/**
 * Stage 1 — crawl npm packuments.
 *
 * BFS outward from the seed list, following only the dependency types that
 * propagate to consumers (config.RESOLVING_DEP_TYPES). Every packument is cached
 * to data/raw/ before anything downstream touches it: the transform and resolve
 * stages get re-run many times while the model settles, and re-fetching several
 * thousand packages each time would be both slow and rude to the registry.
 *
 * Cached documents are trimmed to the fields Kessler models. A full packument for
 * a package like @babel/core is several megabytes of README, dist metadata, and
 * per-version tarball hashes we never read.
 */
import semver from 'semver';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  REGISTRY,
  USER_AGENT,
  CONCURRENCY,
  MAX_DEPTH,
  MAX_PACKAGES,
  MAX_VERSIONS_PER_PACKAGE,
  INCLUDE_PRERELEASE,
  RESOLVING_DEP_TYPES,
  ALL_DEP_TYPES,
  RETRIES,
  RETRY_BASE_MS,
  RAW_DIR,
} from './config.mjs';
import {
  cacheFileFor,
  registryUrlFor,
  ensureDirs,
  readJson,
  writeJson,
  exists,
  sleep,
  progress,
} from './lib.mjs';

const seeds = await readJson(new URL('./seeds.json', import.meta.url));

async function main() {
  await ensureDirs();
  const startedAt = Date.now();

  const queue = [...new Set(seeds)].map((name) => ({ name, depth: 0 }));
  const seen = new Set(queue.map((q) => q.name));
  const manifest = new Map();
  const failures = [];

  let cursor = 0;
  let active = 0;
  let fromCache = 0;
  const report = progress('fetch');

  async function worker() {
    for (;;) {
      if (cursor >= queue.length) {
        if (active === 0) return;
        await sleep(25);
        continue;
      }
      const item = queue[cursor++];
      active += 1;
      try {
        const { doc, cached } = await loadPackument(item.name);
        if (cached) fromCache += 1;
        if (doc) {
          manifest.set(item.name, item.depth);
          if (item.depth < MAX_DEPTH) enqueueDependencies(doc, item.depth);
        }
      } catch (err) {
        failures.push({ name: item.name, error: String(err.message || err) });
      } finally {
        active -= 1;
        report(manifest.size, undefined, `queued ${queue.length} cached ${fromCache}`);
      }
    }
  }

  function enqueueDependencies(doc, depth) {
    for (const version of Object.values(doc.versions)) {
      for (const depType of RESOLVING_DEP_TYPES) {
        for (const dep of Object.keys(version[depType] ?? {})) {
          if (seen.has(dep) || seen.size >= MAX_PACKAGES) continue;
          seen.add(dep);
          queue.push({ name: dep, depth: depth + 1 });
        }
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  report(manifest.size, manifest.size);

  await writeJson(path.join(RAW_DIR, '_manifest.json'), {
    fetchedAt: new Date().toISOString(),
    bounds: {
      maxDepth: MAX_DEPTH,
      maxPackages: MAX_PACKAGES,
      maxVersionsPerPackage: MAX_VERSIONS_PER_PACKAGE,
      includePrerelease: INCLUDE_PRERELEASE,
      resolvingDepTypes: RESOLVING_DEP_TYPES,
    },
    seeds: seeds.length,
    packages: Object.fromEntries(manifest),
    failures,
  });

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `fetched ${manifest.size} packages (${fromCache} from cache) in ${secs}s` +
      (failures.length ? `, ${failures.length} failed` : '')
  );
  if (seen.size >= MAX_PACKAGES) {
    console.log(`note: stopped at the MAX_PACKAGES bound (${MAX_PACKAGES})`);
  }
  if (failures.length) {
    console.log('failures recorded in data/raw/_manifest.json');
  }
}

async function loadPackument(name) {
  const file = cacheFileFor(name);
  if (exists(file)) {
    try {
      const doc = await readJson(file);
      if (isCacheUsable(doc)) return { doc, cached: true };
    } catch {
      // A truncated cache entry from an interrupted run — refetch it.
    }
    await fsp.rm(file, { force: true });
  }
  const doc = await fetchPackument(name);
  if (!doc) return { doc: null, cached: false };
  const trimmed = trim(doc);
  await writeJson(file, trimmed);
  return { doc: trimmed, cached: false };
}

async function fetchPackument(name) {
  const url = registryUrlFor(name, REGISTRY);
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      });
    } catch (err) {
      if (attempt === RETRIES) throw err;
      await sleep(RETRY_BASE_MS * 2 ** attempt);
      continue;
    }

    // Unpublished or renamed packages are a normal part of a real dependency
    // graph, not an error. Record nothing and move on.
    if (res.status === 404) return null;
    if (res.ok) return res.json();

    if (res.status === 429 || res.status >= 500) {
      if (attempt === RETRIES) {
        throw new Error(`${res.status} after ${RETRIES} retries`);
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : RETRY_BASE_MS * 2 ** attempt;
      await sleep(backoff);
      continue;
    }
    throw new Error(`${res.status} ${res.statusText}`);
  }
  throw new Error('exhausted retries');
}

/**
 * A cache entry is only reusable if it was trimmed under bounds at least as wide
 * as the ones we are asking for now. Without this check, raising MAX_VERSIONS
 * would appear to succeed while silently reusing narrower files — the resulting
 * graph would be missing versions with no error anywhere to explain why.
 */
function isCacheUsable(doc) {
  const bounds = doc?._bounds;
  if (!bounds) return false;
  if (bounds.includePrerelease !== INCLUDE_PRERELEASE) return false;
  if (bounds.maxVersions >= MAX_VERSIONS_PER_PACKAGE) return true;
  // A narrower bound is still complete if it captured everything published.
  return Object.keys(doc.versions ?? {}).length >= (doc.versionsTotal ?? Infinity);
}

/**
 * Keep the most recent MAX_VERSIONS_PER_PACKAGE releases, ordered by publish
 * time. Publish time rather than semver order because that is what "recent"
 * means for a supply-chain question, and because backported patch releases to
 * old majors are exactly the versions a blast-radius query cares about.
 */
function trim(doc) {
  const time = doc.time ?? {};
  const candidates = Object.keys(doc.versions ?? {}).filter((v) => {
    if (!semver.valid(v)) return false;
    if (!INCLUDE_PRERELEASE && semver.prerelease(v)) return false;
    return true;
  });

  candidates.sort((a, b) => {
    const ta = Date.parse(time[a] ?? '');
    const tb = Date.parse(time[b] ?? '');
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
    return semver.rcompare(a, b);
  });

  const kept = candidates.slice(0, MAX_VERSIONS_PER_PACKAGE);
  const versions = {};
  const keptTime = {};

  for (const v of kept) {
    const src = doc.versions[v];
    const entry = { version: v };
    for (const depType of ALL_DEP_TYPES) {
      if (src[depType] && Object.keys(src[depType]).length) {
        entry[depType] = src[depType];
      }
    }
    if (src.deprecated) entry.deprecated = true;
    versions[v] = entry;
    if (time[v]) keptTime[v] = time[v];
  }

  return {
    _bounds: {
      maxVersions: MAX_VERSIONS_PER_PACKAGE,
      includePrerelease: INCLUDE_PRERELEASE,
    },
    name: doc.name,
    distTags: doc['dist-tags'] ?? {},
    maintainers: (doc.maintainers ?? [])
      .map((m) => (typeof m === 'string' ? m.split('<')[0].trim() : m?.name))
      .filter(Boolean),
    versionsTotal: candidates.length,
    versions,
    time: keptTime,
  };
}

await main();
