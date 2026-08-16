/**
 * Deterministic sample graph for the landing page's shell diagram.
 *
 * Not fetched, not random: the landing page must render identically on every
 * load and in the demo recording. Real query results replace this inside the
 * app itself.
 */
export type DemoNode = {
  name: string;
  depth: number;
  exposed: boolean;
};

export type DemoEdge = {
  from: string;
  to: string;
  exposed: boolean;
};

const SHELLS: string[][] = [
  ['react-scripts', 'webpack-dev-server', 'eslint-config-react-app'],
  ['webpack', 'terser-webpack-plugin', 'postcss-loader', 'babel-loader', 'workbox-webpack-plugin', 'css-loader'],
  ['schema-utils', 'serialize-javascript', 'loader-utils', 'watchpack', 'enhanced-resolve', 'tapable', 'browserslist', 'mini-css-extract-plugin'],
  ['ajv', 'json5', 'big.js', 'emojis-list', 'glob-to-regexp', 'neo-async', 'graceful-fs', 'chrome-trace-event', 'es-module-lexer', 'eslint-scope'],
  ['fast-deep-equal', 'json-schema-traverse', 'uri-js', 'punycode', 'esrecurse', 'estraverse', 'acorn', 'caniuse-lite', 'electron-to-chromium', 'node-releases', 'update-browserslist-db', 'escalade'],
  ['lodash', 'lodash.merge', 'lodash.template', 'has-flag', 'supports-color', 'color-convert', 'color-name', 'ansi-styles', 'strip-ansi', 'ansi-regex', 'is-fullwidth-code-point', 'emoji-regex', 'string-width', 'wrap-ansi'],
];

// One chain per shell depth, converging on the compromised package at centre.
// These are the paths that light up during the sweep.
const EXPOSED_CHAIN = [
  'react-scripts',
  'webpack',
  'loader-utils',
  'json5',
  'punycode',
  'lodash',
];

export const CENTRE = 'lodash@4.17.21';

const exposed = new Set(EXPOSED_CHAIN);

export const nodes: DemoNode[] = SHELLS.flatMap((names, i) =>
  names.map((name) => ({ name, depth: i + 1, exposed: exposed.has(name) }))
);

const byDepth = new Map<number, DemoNode[]>();
for (const node of nodes) {
  const bucket = byDepth.get(node.depth) ?? [];
  bucket.push(node);
  byDepth.set(node.depth, bucket);
}

/**
 * Every node links one shell inward. Parent choice is a stable function of the
 * node's own index so the layout never shifts between renders.
 */
export const edges: DemoEdge[] = nodes.flatMap((node, i) => {
  if (node.depth === 1) {
    return [{ from: node.name, to: CENTRE, exposed: node.exposed }];
  }
  const inner = byDepth.get(node.depth - 1) ?? [];
  const chainIndex = EXPOSED_CHAIN.indexOf(node.name);
  const parent =
    chainIndex > 0
      ? EXPOSED_CHAIN[chainIndex - 1]
      : inner[i % inner.length].name;
  const parentNode = nodes.find((n) => n.name === parent);
  return [
    {
      from: node.name,
      to: parent,
      exposed: node.exposed && Boolean(parentNode?.exposed),
    },
  ];
});

/**
 * Angular placement is a stable hash of the package name, not insertion order
 * (DESIGN.md §6). The same package sits at the same angle on every render, so
 * re-running a scan shows what changed rather than a reshuffled diagram.
 */
export function angleFor(name: string): number {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 3600) / 10;
}

export const SHELL_RADII = [60, 115, 175, 240, 310, 385];
