/**
 * Static demo mode — replay, never fabricate.
 *
 * The hosted build at kessler-pink.vercel.app has no API behind it: the graph
 * needs a self-hosted HydraDB node, which is not something a static deploy can
 * carry. Rather than ship a page whose every button errors, this module replays
 * a genuinely recorded result for the *one* lockfile the site bundles.
 *
 * The rule that makes this honest, and the reason it is worth reading before
 * changing anything here:
 *
 *   A recorded answer is served only for the exact bytes it was recorded from.
 *
 * Anything else — a judge's own package-lock.json, an edited copy of the
 * example, a different compromised target — gets no answer at all. It falls
 * through to the existing "Could not ask" panel, which says the API is not
 * reachable and how to run it. That is deliberate. Returning the example's
 * findings for someone else's lockfile would be inventing security results
 * about real software, which is the one failure this tool must never have.
 * api.ts states the principle already: "no paths found" and "could not ask"
 * are completely different answers to a security question.
 *
 * Matching therefore fails closed. The hash covers the raw file text, so a
 * single changed byte misses and the user gets honesty instead of a stale
 * result. A false miss costs a demo; a false hit costs the project's claim to
 * being trustworthy.
 */
import recorded from './demo-recorded.json';
import type { ScanResult, ChokePoint } from './api';

export type RecordedScan = ScanResult & { recorded: RecordedProvenance };
export type RecordedChokepoints = {
  totalVersions: number;
  chokepoints: ChokePoint[];
  recorded: RecordedProvenance;
};

/** Shown in the UI so a replayed result is never mistaken for a live one. */
export type RecordedProvenance = {
  at: string;
  graph: { packages: number; versions: number; edges: number };
};

const provenance: RecordedProvenance = {
  at: recorded.recordedAt,
  graph: recorded.graph,
};

/**
 * djb2. Not a security primitive — it only has to distinguish "these are the
 * bytes I recorded from" from "these are not", and a collision would need a
 * deliberately crafted lockfile, which is not a threat model that applies to a
 * read-only demo page.
 */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** True when this is the bundled example, byte for byte. */
function isRecordedLockfile(lockfile: string): boolean {
  return hash(lockfile) === recorded.lockfileHash;
}

/**
 * The recorded scan for this lockfile and target, or null.
 *
 * Null is the common case and the safe one — the caller must surface the
 * original network failure rather than substitute anything.
 */
export function recordedScan(lockfile: string, compromised: string): RecordedScan | null {
  if (!isRecordedLockfile(lockfile)) return null;
  const scan = (recorded.scans as Record<string, ScanResult>)[compromised];
  if (!scan) return null;
  return { ...scan, recorded: provenance };
}

export function recordedChokepoints(lockfile: string): RecordedChokepoints | null {
  if (!isRecordedLockfile(lockfile)) return null;
  return { ...recorded.chokepoints, recorded: provenance };
}

/** Targets with a recorded scan, so the UI can say what the demo can answer. */
export function recordedTargets(): string[] {
  return Object.keys(recorded.scans);
}
