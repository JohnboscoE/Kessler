/**
 * Typo generation.
 *
 * Produces the names a human plausibly types when they mean `name`. This is the
 * half of typosquat detection that cannot come from our own graph: a squat is by
 * definition a package nobody depends on, so it is never in the dependency
 * closure we crawled. We have to guess the names and ask the registry.
 *
 * Every generator is a documented attack class, and each candidate carries the
 * class that produced it so the UI can say *why* a name is suspicious.
 */

// Physical adjacency on QWERTY. A substitution between neighbouring keys is a
// plausible slip; one between distant keys is a different word.
const ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const ADJACENT = buildAdjacency(ROWS);

// npm's own name rules, minus the ones we cannot violate by construction.
const VALID = /^(?:@[a-z0-9-._]+\/)?[a-z0-9-._]+$/;

export const MIN_LENGTH_FOR_CHAR_TYPOS = 5;

export function isValidName(name) {
  if (!name || name.length > 214) return false;
  if (name.startsWith('.') || name.startsWith('_')) return false;
  if (name.endsWith('/') || name.includes('//')) return false;
  return VALID.test(name);
}

/**
 * Returns a Map of candidate name -> attack class.
 *
 * Character operations are applied only to the unscoped portion. Mutating a
 * scope produces a name in someone else's namespace, which is a different attack
 * and is handled separately by the scope generators.
 */
export function generateCandidates(name) {
  const out = new Map();
  const scope = scopeOf(name);
  const bare = stripScope(name);
  const rewrap = (mutated) => (scope ? `@${scope}/${mutated}` : mutated);

  const add = (candidate, kind) => {
    if (!candidate || candidate === name) return;
    if (!isValidName(candidate)) return;
    if (!out.has(candidate)) out.set(candidate, kind);
  };

  // Character-level typos of a short name are not typos, they are other words.
  // `got` generates `git`, `go` and `bot`; `vue` generates `cue` and `due`. All
  // are real, unrelated packages. Measured on a 20-target run, four-character
  // targets produced 73 of 169 edges and essentially all of them were false.
  // Separator and scope attacks stay available at any length.
  const charLevel = bare.length >= MIN_LENGTH_FOR_CHAR_TYPOS;

  for (let i = 0; charLevel && i < bare.length; i += 1) {
    const char = bare[i];

    // Omission — a dropped keystroke. lodash -> lodsh
    add(rewrap(bare.slice(0, i) + bare.slice(i + 1)), 'omission');

    // Duplication — a repeated keystroke. lodash -> lodashh
    add(rewrap(bare.slice(0, i + 1) + char + bare.slice(i + 1)), 'duplication');

    // Adjacent-key substitution — a finger one key off. lodash -> lodasg
    for (const neighbour of ADJACENT.get(char) ?? []) {
      add(rewrap(bare.slice(0, i) + neighbour + bare.slice(i + 1)), 'adjacent-key');
    }

    // Transposition — two keys in the wrong order. lodash -> lodahs
    if (i < bare.length - 1) {
      add(
        rewrap(bare.slice(0, i) + bare[i + 1] + bare[i] + bare.slice(i + 2)),
        'transposition'
      );
    }
  }

  // Separator variation — node-fetch / nodefetch / node_fetch / node.fetch
  if (/[-_.]/.test(bare)) {
    add(rewrap(bare.replace(/[-_.]/g, '')), 'separator');
    add(rewrap(bare.replace(/[-_.]/g, '_')), 'separator');
    add(rewrap(bare.replace(/[-_.]/g, '.')), 'separator');
    add(rewrap(bare.replace(/[-_.]/g, '-')), 'separator');
  } else {
    // ...and the reverse: a hyphen inserted into a name that has none.
    for (let i = 1; i < bare.length; i += 1) {
      add(rewrap(`${bare.slice(0, i)}-${bare.slice(i)}`), 'separator');
    }
  }

  // Scope confusion — an unscoped package wrapped in a scope that imitates it,
  // or a scoped one flattened. @lodash/lodash, lodash-core.
  if (!scope) {
    add(`@${bare}/${bare}`, 'scope');
    const [head, ...rest] = bare.split('-');
    if (rest.length) add(`@${head}/${rest.join('-')}`, 'scope');
  } else {
    add(`${scope}-${bare}`, 'scope');
    add(bare, 'scope');
  }

  return out;
}

export function stripScope(name) {
  const slash = name.indexOf('/');
  return slash === -1 ? name : name.slice(slash + 1);
}

export function scopeOf(name) {
  if (!name.startsWith('@')) return null;
  const slash = name.indexOf('/');
  return slash === -1 ? null : name.slice(1, slash);
}

/** '@babel/core' -> 'babelcore', 'babel-core' -> 'babelcore'. */
export function flatten(name) {
  return name.replace(/^@/, '').replace(/[/\-_.]/g, '');
}

function buildAdjacency(rows) {
  const map = new Map();
  const add = (x, y) => {
    if (!x || !y) return;
    if (!map.has(x)) map.set(x, new Set());
    map.get(x).add(y);
  };
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c += 1) {
      add(row[c], row[c - 1]);
      add(row[c], row[c + 1]);
      for (const nr of [r - 1, r + 1]) {
        const other = rows[nr];
        if (!other) continue;
        add(row[c], other[c - 1]);
        add(row[c], other[c]);
        add(row[c], other[c + 1]);
      }
    }
  });
  return map;
}
