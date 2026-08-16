/**
 * The five queries from KESSLER.md §8, in the forms HydraDB actually accepts.
 *
 * Every form here was probed against a running node on Aug 16; the ones the
 * original plan specified were mostly rejected. The parser's rules, learned the
 * hard way:
 *
 *   - `relDirection` must be 'incoming' | 'outgoing' | 'both'. 'out' is rejected.
 *   - A **list** parameter cannot be passed into a procedure config map:
 *     "composite parameter is only supported as an UNWIND input". Lists must be
 *     inlined as literals. Scalar parameters inside a config map are fine.
 *   - `sourceValues` must be a list of **strings**, matched against
 *     `sourceProperty`. It cannot take integer vertex ids — so traversals resolve
 *     on the `key` property ("name@version"), not on `id`.
 *   - A node pattern carrying a label or a non-id property must be **named**:
 *     `(p:Package {name: $pkg})`, never `(:Package {name: $pkg})`.
 *   - `count(n)` over a bare node variable is rejected; `count(*)` is fine.
 *
 * Because lists must be inlined, the path queries are builders rather than
 * constants. Values are JSON-encoded and validated first — see assertKey.
 */

/** npm names and semver are a narrow charset; anything else is refused rather than escaped. */
const SAFE_KEY = /^[@A-Za-z0-9._/\-+]+$/;

function assertKey(value, what) {
  if (typeof value !== 'string' || !SAFE_KEY.test(value)) {
    throw new TypeError(`unsafe ${what}: ${JSON.stringify(value)?.slice(0, 80)}`);
  }
  return value;
}

function keyList(keys, what) {
  return JSON.stringify(keys.map((k) => assertKey(k, what)));
}

/**
 * Q1 — blast radius. The centrepiece and the Best Use of HydraDB argument: every
 * resolved version in the user's lockfile becomes a source and the traversal
 * runs once, server-side, instead of one round trip per dependency.
 *
 * Verified: 170 paths across 40 sources in 75ms on the 600-package graph.
 */
export function blastRadius({ sourceKeys, targetKey, maxLen = 6, pathCount = 5, resultLimit = 500 }) {
  return `CALL algo.MSpaths({
  sourceLabel: 'Version',
  sourceProperty: 'key',
  sourceValues: ${keyList(sourceKeys, 'source version')},
  targetValues: ${keyList([targetKey], 'target version')},
  pairwise: false,
  relTypes: ['RESOLVES_TO'],
  relDirection: 'outgoing',
  maxLen: ${Number(maxLen)},
  pathCount: ${Number(pathCount)},
  resultLimit: ${Number(resultLimit)}
})
YIELD path
RETURN path`;
}

/**
 * The naive comparison for the §13 timing claim: one bounded traversal per
 * source. Takes scalar parameters, which the config map does accept.
 */
export const BLAST_RADIUS_SINGLE_SOURCE = `
CALL algo.SPpaths({
  sourceNode: $sourceId,
  targetNode: $targetId,
  relTypes: ['RESOLVES_TO'],
  relDirection: 'outgoing',
  maxLen: $maxLen,
  pathCount: $pathCount
})
YIELD path
RETURN path
`.trim();

/**
 * Q2 — introduction point. Bounded variable-length traversal is supported; the
 * node patterns had to be named.
 */
export const INTRODUCTION_POINT = `
MATCH (p:Package { name: $pkg })-[:HAS_VERSION]->(v:Version)
MATCH (v)-[:RESOLVES_TO*1..6]->(bad:Version { key: $compromisedKey })
RETURN v.version AS version, v.published_at AS published_at
ORDER BY v.published_at ASC
LIMIT 1
`.trim();

/** Q3 — live window. Worked as originally written. */
export const LIVE_WINDOW = `
MATCH (v:Version)-[:RESOLVES_TO]->(bad:Version { key: $compromisedKey })
WHERE v.published_at >= $windowStart AND v.published_at <= $windowEnd
RETURN v.key AS id, v.published_at AS published_at
ORDER BY v.published_at ASC
`.trim();

/** Q4 — maintainer overlap. The anonymous `(:Package {...})` pattern was rejected. */
export const MAINTAINER_OVERLAP = `
MATCH (m:Maintainer)-[:MAINTAINS]->(p:Package { name: $pkg })
MATCH (m)-[:MAINTAINS]->(other:Package)
WHERE other.name <> $pkg
RETURN m.key AS maintainer, other.name AS also_maintains
`.trim();

/** Q5 — typosquat neighbourhood. Same named-node fix. */
export const TYPOSQUAT_NEIGHBOURHOOD = `
MATCH (p:Package { name: $pkg })-[s:SIMILAR_NAME]->(sus:Package)
RETURN sus.name AS name, s.distance AS distance, s.kind AS kind,
       s.downloads AS downloads, s.suspicion AS suspicion
ORDER BY s.downloads ASC
`.trim();

/** Does this version exist in the graph — drives the §10 "check the name" copy. */
export const VERSION_EXISTS = `
MATCH (v:Version { key: $key })
RETURN v.key AS id
LIMIT 1
`.trim();

/** `count(p)` over a bare node variable is rejected; `count(*)` is not. */
export const GRAPH_COVERAGE = `
MATCH (p:Package)
RETURN count(*) AS packages
`.trim();

/** Resolve a lockfile key to its integer vertex id, for the SPpaths comparison. */
export const VERTEX_ID_FOR_KEY = `
MATCH (v:Version { key: $key })
RETURN v.id AS id
LIMIT 1
`.trim();

/**
 * Paths come back as a tagged `path` cell whose nodes carry typed properties:
 * `{ properties: { key: { String: "lodash@4.17.21" } } }`. Decoding lives here so
 * the shape is described in one place.
 */
export function decodePath(cell) {
  const nodes = cell?.value?.nodes ?? cell?.nodes ?? [];
  const chain = nodes
    .map((n) => n?.properties?.key?.String ?? n?.properties?.key ?? null)
    .filter(Boolean);
  return chain.length ? { nodes: chain, depth: chain.length - 1 } : null;
}
