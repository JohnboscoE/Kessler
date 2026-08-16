/**
 * package-lock.json -> the set of Version ids that seed a blast-radius query.
 *
 * Handles all three lockfile generations. v2 carries both shapes; `packages` is
 * preferred there because it is flat, records `dev`/`link` accurately, and does
 * not require walking a nested tree.
 *
 * Dev dependencies are excluded by default. KESSLER.md §7.3 excludes them from
 * RESOLVES_TO because they do not propagate to consumers, and including them
 * here while excluding them from the graph would report sources that no edge can
 * ever leave. The count is returned so the UI can say so rather than hide it.
 */

export function parseLockfile(json, { includeDev = false } = {}) {
  const doc = typeof json === 'string' ? JSON.parse(json) : json;
  if (!doc || typeof doc !== 'object') {
    throw new LockfileError('not a JSON object');
  }

  const found = doc.packages
    ? fromPackages(doc.packages)
    : doc.dependencies
      ? fromDependencies(doc.dependencies)
      : null;

  if (!found) {
    throw new LockfileError(
      'no "packages" or "dependencies" key — is this a package-lock.json?'
    );
  }

  const kept = new Map();
  let devSkipped = 0;
  for (const entry of found.entries) {
    if (entry.dev && !includeDev) {
      devSkipped += 1;
      continue;
    }
    const id = `${entry.name}@${entry.version}`;
    if (!kept.has(id)) kept.set(id, entry);
  }

  return {
    lockfileVersion: doc.lockfileVersion ?? 1,
    name: doc.name ?? null,
    versionIds: [...kept.keys()].sort(),
    packages: new Set([...kept.values()].map((e) => e.name)).size,
    devSkipped,
    linkSkipped: found.linkSkipped,
    unresolved: found.unresolved,
  };
}

export class LockfileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockfileError';
  }
}

/** Lockfile v2/v3: a flat map keyed by install path. */
function fromPackages(packages) {
  const entries = [];
  let linkSkipped = 0;
  let unresolved = 0;

  for (const [path, entry] of Object.entries(packages)) {
    // "" is the root project itself, not a dependency.
    if (path === '') continue;
    if (!entry || typeof entry !== 'object') continue;

    // Workspace links point at local directories; there is no registry version
    // to resolve and no node in the graph for them.
    if (entry.link) {
      linkSkipped += 1;
      continue;
    }
    if (!entry.version) {
      unresolved += 1;
      continue;
    }

    entries.push({
      name: entry.name ?? nameFromPath(path),
      version: entry.version,
      dev: Boolean(entry.dev || entry.devOptional),
    });
  }

  return { entries, linkSkipped, unresolved };
}

/** Lockfile v1: a recursively nested tree. */
function fromDependencies(dependencies) {
  const entries = [];
  let unresolved = 0;

  const walk = (node, inheritedDev) => {
    for (const [name, entry] of Object.entries(node ?? {})) {
      if (!entry || typeof entry !== 'object') continue;
      const dev = inheritedDev || Boolean(entry.dev);
      if (entry.version) {
        entries.push({ name, version: entry.version, dev });
      } else {
        unresolved += 1;
      }
      if (entry.dependencies) walk(entry.dependencies, dev);
    }
  };
  walk(dependencies, false);

  return { entries, linkSkipped: 0, unresolved };
}

/**
 * "node_modules/@babel/core"                     -> "@babel/core"
 * "node_modules/a/node_modules/b"                -> "b"
 * "packages/app/node_modules/lodash"             -> "lodash"
 */
function nameFromPath(path) {
  const marker = 'node_modules/';
  const index = path.lastIndexOf(marker);
  return index === -1 ? path : path.slice(index + marker.length);
}
