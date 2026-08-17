import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const RAW_DIR = path.join(ROOT, 'data', 'raw');
export const OUT_DIR = path.join(ROOT, 'data', 'out');

export const REGISTRY = 'https://registry.npmjs.org';
export const USER_AGENT =
  'kessler/0.1 (supply-chain blast radius; https://github.com/Johnbosco/kessler)';

export const CONCURRENCY = num('KESSLER_CONCURRENCY', 12);

// BFS bounds. KESSLER.md §6.3 targets 5,000-10,000 packages; these are the knobs
// that keep it there. Every one of them is a stated limitation in the README —
// a bounded graph we can defend beats a half-ingested one we cannot.
export const MAX_DEPTH = num('KESSLER_MAX_DEPTH', 3);
export const MAX_PACKAGES = num('KESSLER_MAX_PACKAGES', 8000);
export const BATCH = num('KESSLER_BATCH', 1000); // measured: 4,608 rows/s vs 1,174 at 100

// Full packuments carry every version ever published; babel and typescript-adjacent
// packages run to several hundred. Keeping all of them multiplies into millions of
// RESOLVES_TO edges. We keep the most recent N stable releases per package.
export const MAX_VERSIONS_PER_PACKAGE = num('KESSLER_MAX_VERSIONS', 50);
export const INCLUDE_PRERELEASE = bool('KESSLER_PRERELEASE', false);

// Only these propagate transitively to consumers, so only these produce
// RESOLVES_TO edges and only these expand the BFS frontier. See KESSLER.md §7.3 —
// including devDependencies would inflate blast radius dishonestly.
export const RESOLVING_DEP_TYPES = ['dependencies', 'optionalDependencies'];
export const ALL_DEP_TYPES = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
];

// Typosquat scan (ingest/typosquat.mjs). Candidate names are generated and then
// existence-checked against the registry, so this bound controls request volume:
// roughly 50-100 HEAD requests per target.
export const SQUAT_TARGETS = num('KESSLER_SQUAT_TARGETS', 200);
export const SQUAT_MAX_RATIO = Number(process.env.KESSLER_SQUAT_MAX_RATIO ?? 0.02);

export const RETRIES = num('KESSLER_RETRIES', 4);
export const RETRY_BASE_MS = num('KESSLER_RETRY_BASE_MS', 500);

function num(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${key} must be a number, got "${raw}"`);
  return parsed;
}

function bool(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}
