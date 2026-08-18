# Kessler

**Drop in your `package-lock.json`, name a compromised package, and Kessler returns every transitive path from your dependencies to it.**

Named for Kessler syndrome — one collision in orbit produces debris that causes more collisions, until the whole orbital shell is unusable. That is the npm supply-chain failure mode exactly: one compromised package cascades transitively through a dependency graph until hundreds of unrelated services are exposed.

Built for Hack Hydra, Track 02 — *Repos, dependencies and code as graphs*.

---

## The problem

When a package is compromised, the useful question is almost never "do I depend on it." It is:

- How many hops away is it, and along which paths?
- Which of my releases first pulled it in?
- Was I exposed during the window it was actually live?
- Where else could the same credentials reach?

Those are graph questions. A lockfile scanner answers the first one badly and the rest not at all.

---

## What Kessler answers

| | |
|---|---|
| **Blast radius** | Every path from your direct dependencies to a compromised `name@version`, bounded at six hops |
| **Introduction point** | Which version of an intermediate dependency first introduced the edge |
| **Live window** | Which versions resolved to the compromised release while it was live on the registry |
| **Maintainer overlap** | Which other packages share a maintainer with the compromised one |
| **Typosquat neighbourhood** | Published names sitting one keystroke from the packages you depend on |

---

## Answering the track brief

> *"When a package is compromised at 09:00, which of your services are exposed by 09:06? That is a transitive reverse dependency closure over an ecosystem graph with tens of millions of versioned nodes, and it is the kind of question a vector index cannot answer at all."*

| The brief asks for | Kessler | Where |
|---|---|---|
| An npm **or** PyPI dependency graph in HydraDB | npm. 4,765 packages, 86,024 versions, 224,533 resolved edges | `ingest/` |
| Compromised at 09:00 → exposed by 09:06 | One `algo.MSpaths` call, all sources at once | `POST /scan` |
| Transitive **reverse** dependency closure | `algo.SSpaths` with `relDirection: 'incoming'` from the compromised version | `POST /downstream` |
| Which packages share a maintainer with the compromised one | Two-hop pattern across `MAINTAINS` | `GET /maintainers` |
| Which lockfiles resolved to the bad version while it was live | Publish-timestamp window over `RESOLVES_TO` | `GET /live-window` |
| Which names sit close enough to be a typosquat | Generated typos, existence-checked against the registry, graded by download disparity | `GET /typosquats` |

**The two questions are different, and Kessler answers both.** Blast radius asks *"does this project reach the compromise"* — you upload a lockfile. Reverse closure asks *"who downstream is affected"* — you name the compromise and walk inbound edges across the whole graph, which is what you actually need at 09:06 when you do not yet know which services to check. The edge set is identical; only `relDirection` changes.

### Why a vector index cannot answer this

Similarity search retrieves things that *resemble* a query. "Is there a path from my lockfile to `chalk@4.1.2`, and how long is it" is not a resemblance question — it has a discrete, verifiable answer that depends on the existence of specific edges. Embedding `chalk` and finding nearby packages returns things that look like chalk. It cannot tell you that `serve-static@1.16.3` reaches `function-bind@1.1.2` in six hops through `send`, `side-channel` and `call-bound`, because that fact lives in the topology, not in any property of the endpoints. No amount of nearest-neighbour recall reconstructs a path.

### What Kessler does not do

Stated plainly, because the brief describes more than this project attempts:

- **No PyPI.** npm only. The brief says "npm or PyPI"; halving the ingest work bought depth elsewhere.
- **No malware detection.** The brief's description of a worm that self-propagates and persists in `.claude/` and `.vscode/` directories surviving `npm uninstall` is a description of the *threat* (the September 2025 Shai-Hulud campaign), not of this tool. Kessler answers *exposure*, never *"is this package malicious"*. It does not read package contents or install scripts at all.
- **Not tens of millions of nodes.** 86,024 versions, bounded deliberately — see [Honest bounds](#honest-bounds). On-demand lockfile ingest means coverage of *your* project is complete regardless of the crawl's size, which matters more in practice than the total node count.

---

## How HydraDB is used, and what this would lose without it

This is the question the judging asks explicitly, so here is a direct answer.

### The centrepiece: one traversal, every source at once

A blast-radius query is inherently *many sources → one target*. A lockfile contributes hundreds of resolved versions, and each one is a potential starting point. Kessler issues **one** `algo.MSpaths` call:

```cypher
CALL algo.MSpaths({
  sourceLabel: 'Version',
  sourceProperty: 'key',
  sourceValues: [ ...every resolved version in your lockfile... ],
  targetValues: ['debug@4.4.2'],
  pairwise: false,
  relTypes: ['RESOLVES_TO'],
  relDirection: 'outgoing',
  maxLen: 6,
  pathCount: 5,
  resultLimit: 500
})
YIELD path
RETURN path
```

The traversal is evaluated **server-side, across all sources together**, on HydraDB's GraphBLAS-backed engine. The alternative — and the thing `api/server.mjs`'s `/benchmark` endpoint measures against it — is `algo.SPpaths` once per source: N round trips, N traversals, N result sets to merge on the client.

**Without HydraDB, the shape of this product changes.** Not "it would be slower": the natural implementation becomes a client-side BFS that pulls dependency edges out of a store and walks them in application code. That means the graph lives in the client, the depth bound becomes a loop counter, and every query is bounded by network round trips rather than by the traversal itself. The interesting work — bounded multi-source path enumeration over a typed edge — moves out of the database and into JavaScript, which is precisely the thing this track is about not doing.

### What else the graph does

- **`RESOLVES_TO` traversal** is the whole product. Depth-bounded path enumeration over one typed edge, which is a native operation here, not an application loop.
- **Maintainer overlap** is a two-hop pattern match, expressed as a pattern rather than two queries and a join.
- **Typosquat neighbourhood** is a precomputed `SIMILAR_NAME` edge, so "names near mine" is a traversal rather than a scan.

### What HydraDB deliberately does *not* do here

Semver resolution. HydraDB's Cypher subset cannot evaluate `^4.17.0` against a set of published versions, so a graph storing only ranges would have no concrete edges to walk and variable-length traversal would be impossible. Kessler resolves every range **at ingest** into concrete version→version edges. This is the single most important design decision in the project; see [Data model](#data-model).

---

## Data model

```
(:Package    { id, key, name })
(:Version    { id, key, name, version, published_at, deprecated })   // key = "name@version"
(:Maintainer { id, key })                                            // key = npm username
```

```
(:Package)   -[:HAS_VERSION]->  (:Version)
(:Version)   -[:DECLARES { range, dep_type }]-> (:Package)   // raw semver, for display
(:Version)   -[:RESOLVES_TO { range, dep_type }]-> (:Version) // concrete — THE traversal edge
(:Maintainer)-[:MAINTAINS]->    (:Package)
(:Package)   -[:SIMILAR_NAME { distance, kind, downloads, suspicion }]-> (:Package)
```

`id` is a dense integer because **HydraDB vertex identity is integral** — a string id is rejected outright. The human-readable identifier lives on `key`, which is also what `algo.MSpaths` resolves sources against. `ingest/load.mjs` assigns the ids and writes the mapping to `data/out/idmap.json`.

`published_at` is epoch milliseconds as an integer; `-1` means the registry reported no timestamp.

**Only `dependencies` and `optionalDependencies` produce `RESOLVES_TO` edges.** Dev dependencies do not propagate to consumers, so including them would inflate blast radius dishonestly. They are still recorded as `DECLARES` so the UI can show them.

---

## Honest bounds

Everything here is a deliberate, stated limit rather than an accident.

| Bound | Value | Why |
|---|---|---|
| Graph size | **4,765 packages / 86,024 versions / 224,533 resolved edges** in the current build | Seeded from 242 high-download packages, BFS to depth 3, cap 8,000 — not reached. Raise with `KESSLER_MAX_PACKAGES` and `KESSLER_MAX_DEPTH` |
| Path depth | **6 hops** at query time | HydraDB traversals are bounded by design. Real blast radius overwhelmingly sits inside six hops |
| Versions per package | **most recent 30** in the current build (default 50), stable releases only — 18.1 on average, since most packages have fewer than the cap | Popular packages have hundreds of releases; keeping all of them multiplies into millions of edges. Set with `KESSLER_MAX_VERSIONS` |
| Dev dependencies | **excluded** from `RESOLVES_TO` | They do not propagate to consumers |
| Semver strategy | **point-in-time** in the current build | See below |
| Typosquat targets | top 200 seeds, character-level typos only for names ≥5 characters | Shorter names generate other real words, not typos |

### Semver resolution strategy

Both figures below are measured on the current 4,765-package build, over the **250,241** ranges the resolver considers (`dependencies` and `optionalDependencies` whose target package is in the graph). Two strategies are implemented, selected with `KESSLER_RESOLVE_STRATEGY`:

- **`point-in-time`** (current build) — resolve each range only against versions published at or before the dependent's own publish time. Historically accurate: it reconstructs what `npm install` would actually have produced the day that version shipped. Resolution rate **89.7%** (224,533 edges).
- **`latest-satisfying-now`** — resolve against every version held. Simpler, and slightly wrong: it can resolve a 2019 release to a 2024 dependency that did not exist yet. Resolution rate **95.1%** (237,957 edges).

The gap between them is honest, not noise. Part of it is genuine (old ranges with no satisfying version at the time), and part is an artefact of the version cap, which keeps the *newest* versions while point-in-time needs *older* ones. Raising `KESSLER_MAX_VERSIONS` narrows the gap.

### A limitation I did not paper over

The typosquat feature cannot work by scanning the dependency graph, because the crawl walks the dependency closure of popular packages and a typosquat is by definition a package **nobody depends on**. The first implementation produced one edge across 144,359 comparisons, and that edge was a false positive.

So the direction is inverted: `ingest/squat-names.mjs` *generates* the names a human plausibly mistypes (omission, duplication, adjacent-key, transposition, separator, scope), asks the registry which are actually published, and fetches weekly download counts for the survivors. Of 11,517 generated candidates across 200 packages, **736 are really published on npm**.

Download counts are **graded, not thresholded**, because the signal is genuinely ambiguous: zero traffic means a parked squat, a few hundred means a squat that is *working* (accidental installs are the point of the attack), and thousands more likely means a real neighbouring project. The grade ships on the edge so the UI can rank instead of assert.

---

## Requirements

- **Linux, or WSL2 on Windows.** HydraDB documents Ubuntu/WSL and macOS only. There is no native Windows build — bindgen, clang and SuiteSparse GraphBLAS need a real Linux userland. On Windows, check `wsl -l -v` reports **VERSION 2**; a WSL1 distro converts with `wsl --set-version <name> 2`.
- **Rust 1.91+**, and: `build-essential clang libclang-dev cmake pkg-config libcypher-parser-dev libgraphblas-dev`
- **Node 20+**
- **`RUST_MIN_STACK=33554432` is not optional.** Without it the node answers `/readyz` and then aborts with a stack overflow on the first query.

---

## Running it

### 1. Build and start HydraDB

```bash
git clone https://github.com/hydra-db/hydradb.git && cd hydradb
just native-check          # verifies cypher-parser + GraphBLAS are discoverable
just smoke                 # local write / traverse / reopen / verify

mkdir -p .hydradb/store .hydradb/cache
printf '%s\n' 'local-development-token-32-bytes' > .hydradb/auth-token

export CLOUD_PROVIDER=local
export LOCAL_PATH="$PWD/.hydradb/store"
export GRAPH_NAMESPACE=default GRAPH_ID=default
export GRAPH_CELL_ID=cell-0 GRAPH_CELLS=cell-0 GRAPH_NODE_ID=node-0
export GRAPH_BOLT_NODE_ADDRESSES=node-0=127.0.0.1:7687
export GRAPH_ADVERTISED_BOLT_ADDR=127.0.0.1:7687
export GRAPH_DATA_CACHE_DIR="$PWD/.hydradb/cache"
export GRAPH_AUTH_TOKEN_FILE="$PWD/.hydradb/auth-token"
export GRAPH_ALLOW_PLAINTEXT=true
export GRAPH_MAX_QUERY_RUNTIME_MS=300000
export RUST_MIN_STACK=33554432

cargo run --locked --features server-runtime --bin graph-node
```

`GRAPH_MAX_QUERY_RUNTIME_MS` matters for the bulk load. Each edge row MATCHes two
vertices, so batches slow down as the graph fills, and past roughly 100k edges a
batch exceeds the 30s default — admission control then refuses the longer runtime
the loader asks for rather than granting it. The loader also halves any batch
that times out, so it will finish either way, just slowly.

The node holds the foreground — that is it working, not hanging. Ports: Bolt `7687`, HTTP `8443`, admin `9090`. The first build is a long cold compile (~25 min).

### 2. Build the graph

```bash
npm install
npm run ingest      # fetch -> transform -> resolve -> typosquat
node ingest/load.mjs
```

Each stage is independently re-runnable and every network result is cached under `data/raw/`, so re-running the transform or the resolver never re-fetches. `npm run stats` reports the shape of what you built.

**Budget time for the first run.** The typosquat stage issues 50–100 registry existence checks per target — roughly 11,500 requests for the default 200 targets, which takes a few hours on a cold cache and is deliberately rate-limited to stay polite to the registry. Results are cached in `data/raw/_names.json`, so it is a one-time cost. To try the pipeline quickly, shrink it:

```bash
KESSLER_SQUAT_TARGETS=20 npm run typosquat     # ~4 minutes
```

Useful knobs: `KESSLER_MAX_PACKAGES`, `KESSLER_MAX_DEPTH`, `KESSLER_MAX_VERSIONS`, `KESSLER_CONCURRENCY`, `KESSLER_RESOLVE_STRATEGY`, `KESSLER_BATCH`, `KESSLER_SQUAT_TARGETS`.

### 3. Run the API and the app

```bash
npm run api         # Fastify on http://127.0.0.1:8787
npm run dev         # Vite on http://localhost:5173
```

### 4. Verify the graph answers

```bash
node api/probe-queries.mjs
```

Runs all five §8 queries plus the supporting lookups against the loaded graph and reports which forms the parser accepts. Re-run it after any change to `api/queries.mjs`.

---

## Repo layout

```
ingest/     five-stage pipeline: fetch, transform, resolve, typosquat, load
api/        Fastify API, HydraDB client, the five queries, probe harnesses
web/        Vite + React front end
KESSLER.md  planning, decision log, and verified findings about HydraDB
DESIGN.md   the visual system
```

---

## What I learned about HydraDB's Cypher subset

Recorded because most of it is not in the documentation, and because every one of these was discovered by hitting it. Full detail in `KESSLER.md` §3.2.

- Vertex ids must be **non-negative integers**.
- The query-parameter field is **`parameters`**, not `params`.
- A **list** parameter is only accepted as an `UNWIND` input. It cannot be passed into a procedure config map, so `sourceValues` must be inlined as a literal. Scalar parameters inside a config map are fine.
- `relDirection` must be `'incoming' | 'outgoing' | 'both'`. `'out'` is rejected.
- `sourceValues` must be a list of **strings**, matched against `sourceProperty`.
- Node patterns carrying a label or non-id property must be **named**: `(p:Package {name: $pkg})`, not `(:Package {name: $pkg})`.
- `count(*)` works; `count(n)` over a bare node variable does not. A standalone `RETURN 1` is rejected.
- `UNWIND` batch forms are narrow: vertex upserts are `MERGE (n {id: row.id})` then `SET`; edges must MATCH both endpoints with exactly one label each, then CREATE one directed single-hop relationship with nothing following it. A relationship carrying properties needs its own integer `id`.
- Bounded variable-length traversal (`-[:RESOLVES_TO*1..6]->`) **is** supported.

Because `sourceValues` must be inlined rather than parameterised, every key is validated against a strict charset before interpolation — see `assertKey` in `api/queries.mjs`.

---

## Attribution

- Package metadata from the [npm registry](https://registry.npmjs.org) public packument API, and download counts from `api.npmjs.org`. No authentication, no scraping.
- Semver range resolution by [`semver`](https://www.npmjs.com/package/semver).
- Graph storage and traversal by [HydraDB](https://github.com/hydra-db/hydradb).
- Front end: React, Vite. API: Fastify.

---

## License

Kessler is **MIT** — see [LICENSE](LICENSE).

Kessler communicates with HydraDB (AGPL-3.0) as a separate, unmodified network service over its Bolt and HTTP interfaces. No HydraDB source is copied into or linked with this project.
