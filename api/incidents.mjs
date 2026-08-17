/**
 * Documented npm supply-chain compromises.
 *
 * These are real, publicly reported incidents. They exist so a user without an
 * active advisory in front of them has somewhere to start, and so the demo is
 * verifiably not rigged — every entry can be checked against public reporting.
 *
 * The version strings are the compromised releases as reported. A package being
 * listed here says nothing about the project today: nearly all of these were
 * remediated within hours, and the maintainers were usually victims themselves.
 */
export const INCIDENTS = [
  {
    pkg: 'debug',
    version: '4.4.2',
    date: '2025-09',
    label: 'debug 4.4.2',
    summary:
      'Maintainer account phished; malicious releases of debug and chalk published. Deep in almost every Node dependency tree.',
  },
  {
    pkg: 'chalk',
    version: '5.6.1',
    date: '2025-09',
    label: 'chalk 5.6.1',
    summary: 'Published in the same campaign as debug. Browser-side wallet-draining payload.',
  },
  {
    pkg: '@solana/web3.js',
    version: '1.95.7',
    date: '2024-12',
    label: '@solana/web3.js 1.95.7',
    summary: 'Publish token stolen; releases exfiltrated private keys.',
  },
  {
    pkg: 'ua-parser-js',
    version: '0.7.29',
    date: '2021-10',
    label: 'ua-parser-js 0.7.29',
    summary: 'Account hijack; releases installed a cryptominer and a credential stealer.',
  },
  {
    pkg: 'coa',
    version: '2.0.3',
    date: '2021-11',
    label: 'coa 2.0.3',
    summary: 'Hijacked and used to ship a credential stealer; a build dependency of many React apps.',
  },
  {
    pkg: 'rc',
    version: '1.2.9',
    date: '2021-11',
    label: 'rc 1.2.9',
    summary: 'Compromised alongside coa in the same campaign.',
  },
  {
    pkg: 'node-ipc',
    version: '10.1.1',
    date: '2022-03',
    label: 'node-ipc 10.1.1',
    summary: 'Maintainer added destructive protestware that overwrote files by geolocation.',
  },
  {
    pkg: 'event-stream',
    version: '3.3.6',
    date: '2018-11',
    label: 'event-stream 3.3.6',
    summary:
      'The canonical case: maintainership handed to an attacker, who added flatmap-stream to steal Bitcoin wallets.',
  },
];

/** Any of these present in the graph, so the UI only offers ones that resolve. */
export function incidentKeys() {
  return INCIDENTS.map((i) => `${i.pkg}@${i.version}`);
}
