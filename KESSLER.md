# KESSLER — Hack Hydra handoff

> **Read this first, Claude Code.** This is a planning + status document for a hackathon
> project. Nothing in it has been executed yet. Section 3 marks what is VERIFIED (read from
> official docs) vs UNVERIFIED (assumption that must be tested before it is built on).
>
> **Your first job is not to write application code.** It is to run Section 5 (Gate 0) and
> update Section 3's status table with real results. If Gate 0 fails, say so plainly and stop
> — do not work around it silently.
>
> **Keep this file current.** After every work session, update Section 3 and Section 12
> (Status Log). This file is the single source of truth for what actually works.

---

## 1. What this is

**Project name: Kessler.**

Named for Kessler syndrome — one collision in orbit produces debris that causes more
collisions, until the whole orbital shell is unusable. That is precisely the npm supply-chain
failure mode: one compromised package cascades transitively through a dependency graph until
hundreds of unrelated services are exposed.

**One-line pitch:** Drop in your `package-lock.json`, name a compromised package, and Kessler
returns every transitive path from your dependencies to it — plus which of your versions first
introduced the exposure, which packages share a maintainer with the compromised one, and which
nearby names are likely typosquats.

**Entry:** Hack Hydra, Track 02 (Repos, dependencies and code as graphs), option **A — Supply
chain blast radius**.

**Why this track and not the others:** see Section 11 (Decision Log). Do not relitigate.

---

## 2. Hard constraints

| Constraint | Value |
|---|---|
| Submission deadline | **Aug 20, 2026, 23:59 PT** = **Aug 21, 08:59 CEST** |
| Build window opened | Aug 12, 2026 |
| Planning started | Aug 15, 2026 |
| Team | Solo |
| Repo | Must be public, fresh, **no commits before Aug 12, 2026** |
| License | Must include an OSS license. Use **MIT** (see Section 10 on AGPL) |
| Deliverables | Public GitHub repo + demo video ≤3:00 + submission form |

**Disqualification triggers to actively avoid:**
- Any commit dated before Aug 12
- Private repo, or missing license file
- Missing demo video
- HydraDB not doing meaningful work (i.e. if the graph ends up being a formality)
- Late submission

**Video is capped at 3:00 and anything past that may not be reviewed.** Script it. Do not
improvise.

---

## 3. HydraDB — what we know

Source: `https://github.com/hydra-db/hydradb` README + `https://hackhydra.hydradb.com/`.
Read from documentation only. **Nothing below marked UNVERIFIED has been run.**

### 3.1 What it is

Object-store-native distributed graph database written in Rust. S3-compatible object storage
is the durable source of truth (SlateDB). Speaks **Bolt 5.x (Neo4j-driver compatible)** and an
**HTTPS JSON/NDJSON API**. AGPL-3.0. As of Aug 15: ~13 stars, 4 forks, 28 commits.

### 3.2 Status table — UPDATE THIS AS YOU GO

| Item | Status | Notes |
|---|---|---|
| Builds on WSL2 Ubuntu | **VERIFIED** | Aug 16. Host distro was WSL**1** — converted in place (~70 min). Rust 1.95, clang/libclang/cmake/libcypher-parser-dev/libgraphblas-dev via apt. Note `wsl -u root` needs no password; sudo inside the distro does |
| Builds via Dockerfile | UNVERIFIED | Not attempted — the native path worked |
| `just native-check` passes | **VERIFIED** | Aug 16 |
| `just smoke` passes | **VERIFIED** | Aug 16. "graph object-store smoke passed at epoch 10". Cold compile 24m30s |
| Local server + HTTP round trip | **VERIFIED** | Aug 16. Returned `{"type":"vertex_id","value":2}` as documented. Reachable from Windows too — WSL2 localhost forwarding works, so the Node API can run on the host |
| Node/TS `neo4j-driver` connects over Bolt | NOT ATTEMPTED | The HTTP API covers everything Kessler needs, and §5.3 says not to burn hours on Bolt. Bolt port listens |
| `algo.MSpaths` works as documented | **VERIFIED — with corrections** | Aug 16. Works, but **not** as §8 wrote it. `sourceValues` must be a list of **strings** matched against `sourceProperty`, so traversal resolves on `key` ("name@version"), not on `id`. `relDirection` must be `'outgoing'`, not `'out'`. Measured: 60 connected sources → 268 paths, max depth 3, ~500-1200ms on the 600-package graph. Arbitrary sources correctly return 0 |
| **Vertex ids must be integers** | **VERIFIED — model change** | Aug 16. "UNWIND row 0 field id must be a non-negative integer". Kessler is keyed on strings throughout, so the loader assigns dense integer ids and keeps the string on a `key` property, writing `data/out/idmap.json` |
| Query parameter field name | **VERIFIED** | It is `parameters`, not `params` (`src/client/http.rs:289`) |
| **List parameters** | **VERIFIED — constraint** | A composite parameter "is only supported as an UNWIND input". Lists cannot be passed into a procedure config map, so `sourceValues` is inlined as a literal (validated against a strict charset in `api/queries.mjs`). Scalar parameters inside a config map are fine |
| UNWIND batch write form | **VERIFIED — narrow** | Vertex upsert must be `MERGE (n {id: row.id})` then `SET`; properties cannot be folded into the MERGE pattern. Edges must MATCH both endpoints **with exactly one label each** then CREATE one directed single-hop relationship, nothing following. A relationship carrying properties needs its own integer `id` as the first property. Inline literal lists rejected |
| MERGE support | **VERIFIED PRESENT** | Contrary to the original assumption. It is the documented and required form for vertex upserts |
| Aggregates | **VERIFIED — partial** | `count(*)` works; `count(n)` over a bare node variable is rejected. Standalone `RETURN 1` is rejected — "row execution supports MATCH ... RETURN queries" |
| Named node patterns | **VERIFIED — required** | `(:Package {name: $pkg})` is rejected: "node labels and non-id properties require a named node". Must be `(p:Package {name: $pkg})` |
| All five §8 queries | **VERIFIED** | Aug 16, 9/9 forms pass `node api/probe-queries.mjs`. Q2's `RESOLVES_TO*1..6` bounded variable-length **is** supported — no fallback to SSpaths needed |
| Property index creation syntax | **ANSWERED — no DDL exists** | Aug 15. Zero `CREATE INDEX`/`DROP INDEX` in the Rust source; zero mentions of "index" in `cypher-compat.md`. Indexes are not user-declared: `architecture.md:121` lists "vertex and relationship property indexes" as canonical SlateDB records, and `graph-indexer` builds immutable traversal indexes in the background. **There is nothing to create — the §3.5 worry is void.** New question it raises: whether `graph-indexer` must also run locally for `algo.MSpaths` source resolution to be fast, or whether `graph-node` alone suffices. Test during 5.3 |
| Vector / embedding support | **VERIFIED ABSENT** | Aug 15. `embedding` 0 hits, `hnsw` 0, `cosine` 0. All 155 `vector` hits are GraphBLAS sparse linear algebra (`GrB_Vector`, `GrBVector`, `degree_vector`) — traversal internals, unrelated to similarity search. The marketing site's hybrid vector+graph claim is not in the OSS repo. Kessler does not need it |
| UNWIND batch write throughput | **VERIFIED** | Aug 17. Batch size is hard-capped at **1024** by `DEFAULT_MAX_PARAMETERS` in `src/client/service.rs:37`, which is not wired to any config — anything larger is refused as `client_query_batch_items`. Vertex upserts ~4,600 rows/s at batch 1000 (vs 1,174 at batch 100). Edge writes are far slower because each row MATCHes two vertices: **88 rows/s sustained** over 15,000 edges against an 86k-vertex graph, with no decay across rounds |
| Max practical graph size on one node | **VERIFIED at this scale** | Aug 17. 4,765 packages / 86,024 versions / 224,533 RESOLVES_TO edges loads and queries fine. Traversals stay sub-second; `algo.MSpaths` over 156 sources returns in ~1s. **What degrades is full label scans** — `MATCH (n:Version) RETURN count(*)` times out at 86k nodes, so avoid them; indexed `{id: ...}` lookups stay at 14-90ms |
| Query runtime ceiling | **VERIFIED — configurable** | Aug 17. Defaults to 30s and admission control **refuses** a longer `timeout_ms` rather than clamping it (`client_query_runtime_ms rejected`). Raise on the node with `GRAPH_MAX_QUERY_RUNTIME_MS`. The loader also halves any batch that times out, so it completes either way |

### 3.3 Query surface — VERIFIED from README

Supported OpenCypher subset:
- Typed relationships
- **Bounded** variable-length paths
- Property and label predicates
- Ordering, pagination, aggregation
- `OPTIONAL MATCH`, `UNION`
- Batched `UNWIND` writes

Native path procedures:
- `algo.SPpaths` — bounded paths, one source → one target
- `algo.SSpaths` — bounded paths from one source
- `algo.MSpaths` — many indexed sources and targets, evaluated together server-side

`algo.MSpaths` signature as documented:

```cypher
CALL algo.MSpaths({
  sourceLabel: 'Entity',
  sourceProperty: 'name',
  sourceValues: ['alpha', 'beta', 'gamma'],
  targetValues: ['alpha', 'beta', 'gamma'],
  pairwise: true,
  relTypes: ['RELATES'],
  relDirection: 'both',
  maxLen: 3,
  pathCount: 5,
  fairRelationshipVariants: true,
  resultLimit: 100
})
YIELD path
RETURN path
```

### 3.4 What is NOT available — plan around this

- **No APOC. No GDS.** No PageRank, no community detection, no built-in shortest-weighted-path.
- **No unbounded transitive closure.** Every traversal needs an explicit `maxLen`. Kessler caps
  at depth 6 and states this openly in the README — most real blast radius sits well inside it.
- **No semver evaluation in the query layer.** Cypher cannot resolve `^4.17.0` against a
  version set. This forces the single most important design decision in Section 7.
- **Vector search: assume absent** until verified otherwise.

### 3.5 Open question you must answer on day one

**Property indexes.** The planner reportedly uses them, but the README never documents
creating one. Without an index on `Version.id` and `Package.name`, both ingest (MERGE-style
lookups) and `algo.MSpaths` source resolution — which explicitly takes a `sourceLabel` +
`sourceProperty` and calls them "indexed source values" — may degrade to full scans. This
could be the difference between a 30-second ingest and a 30-minute one.

Where to look, in order:
1. `rg -i "CREATE INDEX|index" src/query/` — check the parser for index DDL
2. `examples/` — the import example probably shows the intended pattern
3. `architecture.md` — has a section on indexing
4. `cypher-compat.md` — likely states exactly which DDL is supported
5. Ask in the Hack Hydra Discord — the team runs office hours all nine days and this is
   exactly the kind of question they will answer fast

Record the answer in Section 3.2.

---

## 4. Environment

**Host: Windows, primary terminal Git Bash.** HydraDB documents **Ubuntu/WSL and macOS only**.
There is no native Windows build path. Git Bash alone will not work — bindgen, clang, and
SuiteSparse GraphBLAS need a real Linux userland.

Two options, in preference order:

**A. WSL2 Ubuntu (recommended for iteration speed)**

```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential clang libclang-dev cmake pkg-config \
  libcypher-parser-dev libgraphblas-dev \
  curl git python3 python3-venv
# Rust 1.91+
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install just --locked
```

**B. Docker build (more reproducible, and gives a deployment artifact)**

Same Rust compile, just containerised. Preferable if WSL toolchain fights back, and it
produces the image you would deploy to Railway.

**Expect a long cold compile.** This is a Rust workspace with GraphBLAS linkage and bindgen.
Kick it off before doing anything else and work on the ingest scraper while it runs — the
scraper needs no database.

---

## 5. Gate 0 — do this before writing any application code

### 5.1 Toolchain

```bash
git clone https://github.com/hydra-db/hydradb.git
cd hydradb
just native-check
just smoke
```

`just smoke` creates a local graph, writes and deletes edges, runs a sparse traversal, closes,
reopens, and verifies durability. If it passes, storage works.

### 5.2 Run a node

```bash
mkdir -p .hydradb/store .hydradb/cache
printf '%s\n' 'local-development-token-32-bytes' > .hydradb/auth-token

export CLOUD_PROVIDER=local
export LOCAL_PATH="$PWD/.hydradb/store"
export GRAPH_NAMESPACE=default
export GRAPH_ID=default
export GRAPH_CELL_ID=cell-0
export GRAPH_CELLS=cell-0
export GRAPH_NODE_ID=node-0
export GRAPH_BOLT_NODE_ADDRESSES=node-0=127.0.0.1:7687
export GRAPH_ADVERTISED_BOLT_ADDR=127.0.0.1:7687
export GRAPH_DATA_CACHE_DIR="$PWD/.hydradb/cache"
export GRAPH_AUTH_TOKEN_FILE="$PWD/.hydradb/auth-token"
export GRAPH_ALLOW_PLAINTEXT=true
export RUST_MIN_STACK=33554432   # NOT OPTIONAL — see 5.4

cargo run --locked --features server-runtime --bin graph-node
```

The node holds the foreground. That is it working, not hanging. Use a second shell.

Ports: Bolt `127.0.0.1:7687`, HTTP `127.0.0.1:8443`, admin `127.0.0.1:9090`.

### 5.3 Prove a round trip — this is the actual gate

A listening port proves nothing. A round-tripped write does.

```bash
TOKEN='local-development-token-32-bytes'

curl -sS http://127.0.0.1:8443/v1/graphs/default/query \
  -H "Authorization: Bearer $TOKEN" \
  -H 'X-Graph-Namespace: default' \
  -H 'Content-Type: application/json' \
  --data '{"cell_id":"cell-0","query":"CREATE (a {id: 1})-[:FOLLOWS]->(b {id: 2})"}'

curl -sS http://127.0.0.1:8443/v1/graphs/default/query \
  -H "Authorization: Bearer $TOKEN" \
  -H 'X-Graph-Namespace: default' \
  -H 'Content-Type: application/json' \
  --data '{"cell_id":"cell-0","query":"MATCH (a {id: 1})-[:FOLLOWS]->(b) RETURN b.id AS id"}'
```

Expected: one row, `{"type":"vertex_id","value":2}`.

Then immediately prove the Node client path, because the whole application depends on it:

```bash
npm i neo4j-driver
```

```js
import neo4j from 'neo4j-driver';
const driver = neo4j.driver(
  'neo4j://127.0.0.1:7687',
  neo4j.auth.bearer('local-development-token-32-bytes')
);
// If bearer auth fails, try neo4j.auth.basic — record which one works in Section 3.2.
const session = driver.session({ database: 'default' });
const r = await session.run('MATCH (a {id: 1})-[:FOLLOWS]->(b) RETURN b.id AS id');
console.log(r.records.map(x => x.toObject()));
```

**If Bolt auth is awkward, do not burn hours on it.** Fall back to the HTTP API with `fetch`.
It is fully documented and sufficient for everything Kessler needs.

### 5.4 Documented failure modes — do not rediscover these

| Symptom | Fix |
|---|---|
| Node answers `/readyz`, then aborts with "has overflowed its stack" on first query | `export RUST_MIN_STACK=33554432` |
| `invalid environment variable CLOUD_PROVIDER value \`null\`` | `CLOUD_PROVIDER` unset; `local` also needs `LOCAL_PATH` pointing at a directory that **already exists** |
| `'cypher-parser.h' file not found` | Only on macOS when calling cargo directly. Prefer `just`, which exports `BINDGEN_EXTRA_CLANG_ARGS` |
| `curl: (7) Failed to connect ... 9090` | Node not running; it holds the foreground, needs its own shell |

Also read `AGENTS.md` in the HydraDB repo — it is written for coding agents and carries the
same sequence plus repository conventions.

### 5.5 Gate 0 exit criteria

Do not proceed to Section 6 until **all** of:
- [ ] `just smoke` passes
- [ ] Node serves a write and a read over HTTP with correct results
- [ ] A Node/TS client (Bolt or HTTP) round-trips a query
- [ ] Section 3.2 updated with real results
- [ ] Property-index question (3.5) answered or escalated to Discord

**If Gate 0 cannot be cleared, report that clearly.** Five days is not enough to also debug a
Rust graph database's build system.

---

## 6. Kessler — scope

### 6.1 What it does

1. **Blast radius.** Given a compromised `package@version`, return every path from a user's
   direct dependencies to it, bounded at depth 6.
2. **Introduction point.** For each exposed path, which version of the intermediate dependency
   first introduced the edge.
3. **Live window.** Which versions resolved to the compromised version during the window it was
   live (needs publish timestamps).
4. **Maintainer overlap.** Which other packages share a maintainer with the compromised one —
   the "where might they go next" question.
5. **Typosquat neighbourhood.** Which published names sit within small edit distance of a
   popular package.

   > **Was blocked, now solved — Aug 15.** The original design compared popular names
   > against packages in the ingested graph and could not work: the crawl walks the *dependency
   > closure* of popular seeds, so everything in it is a package something depends on,
   > while a typosquat is definitionally a package nobody depends on. It produced one edge
   > across 144,359 comparisons and that edge was a false positive.
   >
   > Note the registry search endpoint does **not** fix this either — it is token-based, so
   > `text=lodash` never returns `lodahs`.
   >
   > The working approach inverts the direction: *generate* the names a human plausibly
   > mistypes (omission, duplication, adjacent-key, transposition, separator, scope), then
   > ask the registry which are actually published, then fetch weekly downloads for the
   > survivors. Implemented in `ingest/squat-names.mjs` + `ingest/typosquat.mjs`.
   >
   > Two calibrations were needed, both measured rather than guessed:
   > * **Targets under 5 characters are excluded from character-level typos.** `got`
   >   generates `git`/`go`/`bot`, `vue` generates `cue`/`due` — all real, unrelated
   >   packages. Four-character targets produced 73 of 169 edges and essentially all were
   >   false.
   > * **Downloads are graded, not thresholded.** Zero traffic = parked squat; a few
   >   hundred = a squat that is working, since accidental installs are the whole point;
   >   thousands = probably a real neighbouring project. The grade ships on the edge so the
   >   UI ranks instead of asserting.
   >
   > Result on 20 targets: 978 candidates generated, 162 actually published, 96 edges after
   > filtering. Against axios (119M weekly downloads) it finds `aaxios`, `aios`, `axio`,
   > `axioos`, `axioss`, `axiso`, `axos`, `adios` — every one published, every one at or
   > near zero downloads.

### 6.2 Explicit non-goals — do NOT build these

- PyPI (npm only)
- Actual malware detection or code scanning
- Real-time monitoring, alerting, or webhooks
- User accounts, auth, persistence of user uploads
- A vector-search baseline for comparison
- A second track entry
- Ingesting all of npm

**If a feature is not in 6.1, the answer is no.** Scope creep is the most likely cause of
failure here, ahead of any technical risk.

### 6.3 Graph scale target

**5,000–10,000 packages.** Seed from ~200 high-download packages, BFS their dependency closure
to depth 3–4. State the bound plainly in the README. A bounded graph you can defend beats a
half-ingested one you cannot.

---

## 7. Data model

### 7.1 The critical decision: resolve semver at INGEST, not at query time

HydraDB's Cypher subset cannot evaluate `^4.17.0` against a set of published versions. If you
store only semver ranges, variable-length path traversal is impossible — the graph would have
no concrete edges to walk.

**Therefore: precompute concrete `RESOLVES_TO` edges at ingest time** using the `semver` npm
package. For each `Version` and each of its dependency ranges, resolve the range against the
target package's published versions and write a concrete version→version edge.

This is the whole architecture. Get it wrong and nothing else works.

**Two resolution strategies:**

- **Point-in-time (correct):** resolve against versions published *at or before* this version's
  own publish time. Historically accurate — matches what a real install would have produced.
- **Latest-satisfying-now (cheap):** resolve against all published versions. Simpler, faster,
  slightly wrong.

Start with **latest-satisfying-now** to unblock everything. Upgrade to point-in-time on Day 3
if time allows — it is a strong differentiator for the Best Use of HydraDB award because it
makes the graph genuinely temporal. Document whichever you ship.

### 7.2 Nodes

```
(:Package   { name })
(:Version   { id, name, version, published_at, deprecated })   // id = "name@version"
(:Maintainer{ id })                                            // npm username
```

`published_at` as epoch milliseconds (integer). Do not rely on date types being supported.

### 7.3 Edges

```
(:Package)   -[:HAS_VERSION]->  (:Version)
(:Version)   -[:DECLARES { range, dep_type }]-> (:Package)     // raw semver, for display
(:Version)   -[:RESOLVES_TO]->  (:Version)                     // concrete — THE traversal edge
(:Maintainer)-[:MAINTAINS]->    (:Package)
(:Package)   -[:SIMILAR_NAME { distance, kind }]-> (:Package)  // precomputed typosquat
```

`RESOLVES_TO` is the only edge type used for blast-radius traversal. `DECLARES` exists so the
UI can show the human-readable range that produced each resolution.

`dep_type` ∈ `dependencies` | `devDependencies` | `optionalDependencies` | `peerDependencies`.
**Only `dependencies` and `optionalDependencies` participate in `RESOLVES_TO`** — dev deps do
not propagate transitively to consumers, and including them would inflate blast radius
dishonestly. Judges who know npm will notice. Say this in the README.

### 7.4 Typosquat edges

Precompute at ingest. For each of the top ~500 packages by downloads, find published names
within Damerau-Levenshtein distance ≤ 2, plus these classes:
- character omission / duplication (`lodahs`, `lodashh`)
- adjacent-key substitution (`lodasg`)
- scope confusion (`lodash` vs `@types/lodash` vs `lodash-es` lookalikes)
- separator variation (`node-fetch` / `nodefetch` / `node_fetch`)

Store `kind` so the UI can explain *why* a name is suspicious. Exclude legitimate ecosystem
patterns (`@types/*`, `*-es`, `*-cjs`) or the results will be noise.

---

## 8. The queries

Write these as parameterised templates in one module. They are the product.

**Q1 — Blast radius (the centrepiece).** Many sources (user's lockfile) → one target
(compromised version), resolved server-side in a single call:

```cypher
CALL algo.MSpaths({
  sourceLabel: 'Version',
  sourceProperty: 'id',
  sourceValues: $lockfileVersionIds,
  targetValues: [$compromisedVersionId],
  pairwise: false,
  relTypes: ['RESOLVES_TO'],
  relDirection: 'out',
  maxLen: 6,
  pathCount: 5,
  resultLimit: 500
})
YIELD path
RETURN path
```

**This single call is the Best Use of HydraDB argument.** One server-side many-source
traversal instead of N client round trips. Time it against a naive client-side BFS over the
same graph and put the number in the video. If `pairwise: false` does not behave as expected,
test `true` and record the difference.

**Q2 — Introduction point.**

```cypher
MATCH (p:Package { name: $pkg })-[:HAS_VERSION]->(v:Version)
MATCH (v)-[:RESOLVES_TO*1..6]->(bad:Version { id: $compromisedVersionId })
RETURN v.version AS version, v.published_at AS published_at
ORDER BY v.published_at ASC
LIMIT 1
```

**Q3 — Live window.**

```cypher
MATCH (v:Version)-[:RESOLVES_TO]->(bad:Version { id: $compromisedVersionId })
WHERE v.published_at >= $windowStart AND v.published_at <= $windowEnd
RETURN v.id AS id, v.published_at AS published_at
ORDER BY v.published_at ASC
```

**Q4 — Maintainer overlap.**

```cypher
MATCH (m:Maintainer)-[:MAINTAINS]->(:Package { name: $pkg })
MATCH (m)-[:MAINTAINS]->(other:Package)
WHERE other.name <> $pkg
RETURN m.id AS maintainer, collect(other.name) AS also_maintains
```

**Q5 — Typosquat neighbourhood.**

```cypher
MATCH (:Package { name: $pkg })-[s:SIMILAR_NAME]->(sus:Package)
RETURN sus.name AS name, s.distance AS distance, s.kind AS kind
ORDER BY s.distance ASC
```

**Test every one of these against the subset in Section 3.3 before building UI on top.** If
`RESOLVES_TO*1..6` is unsupported in the parser, fall back to `algo.SPpaths` / `algo.SSpaths`.
Record which forms work in Section 3.2.

---

## 9. Ingestion

**Source:** npm registry packuments — `https://registry.npmjs.org/{name}`. Returns all
versions, `versions[v].dependencies`, a `time` object with per-version publish timestamps, and
`maintainers`. Everything needed, no auth, no LLM, no embeddings.

**Pipeline (Node/TS):**

1. **Fetch** — BFS from seed list, concurrency ~10–15, cache every packument to
   `data/raw/{name}.json`. Be polite; the registry rate-limits. **Cache is not optional** —
   you will re-run the transform many times and must not re-fetch.
2. **Transform** — packuments → normalised JSONL: `packages.jsonl`, `versions.jsonl`,
   `maintainers.jsonl`, `declares.jsonl`.
3. **Resolve** — build `resolves_to.jsonl` using `semver.maxSatisfying`. Slowest step; make it
   independently re-runnable so strategy can be switched without re-fetching.
4. **Typosquat** — build `similar_name.jsonl`.
5. **Load** — batched `UNWIND` writes into HydraDB.

**Load pattern:**

```cypher
UNWIND $rows AS row
CREATE (v:Version { id: row.id, name: row.name, version: row.version,
                    published_at: row.published_at })
```

Benchmark batch sizes 100 / 500 / 1000 and record the best in Section 3.2. If MERGE-style
deduplication is unsupported or slow, deduplicate in the transform step and use plain `CREATE`
— the JSONL files are the deduplication boundary, not the database.

**Make the loader idempotent from a clean store.** You will wipe and reload many times. A
`just`-style script or npm script that drops `.hydradb/store`, restarts the node, and reloads
end to end will pay for itself by Day 3.

---

## 10. Stack, deployment, licensing

| Layer | Choice | Rationale |
|---|---|---|
| Graph DB | HydraDB in Docker | Required by the hackathon |
| Ingest | Node/TS scripts | Native stack, no learning cost |
| API | Node/TS + Fastify or Express, Railway | Known deployment path |
| Frontend | React/TS + Vite, Vercel | Known deployment path |
| DB client | `neo4j-driver` over Bolt, **fallback** to HTTP `fetch` | Fallback documented in 5.3 |

**Deployment risk:** a Rust graph database with GraphBLAS may exceed Railway's small-tier
memory. Try it, but **do not let deployment block submission**. The form says "Deployed
project link, *if available*." A local demo in the video is fully acceptable. Budget at most
two hours for deployment; if it resists, ship local and move on.

**Licensing.** HydraDB is **AGPL-3.0**. Kessler talks to it over Bolt/HTTP as a separate,
unmodified server process, so license Kessler **MIT** and state explicitly in the README:

> Kessler communicates with HydraDB (AGPL-3.0) as a separate, unmodified network service over
> its Bolt and HTTP interfaces. No HydraDB source is copied into or linked with this project.

**If you patch HydraDB itself, AGPL propagates and Kessler's license must follow.** Prefer
working around bugs in the client layer. If a patch is genuinely unavoidable, keep it in a
separate forked repo, note it in the README, and flag it to the user before doing it.

---

## 11. Decision log — do not relitigate

| Decision | Reasoning |
|---|---|
| Track 02A, not 02B (code graphs) | 02B requires building a vector baseline *and* beating it to prove the thesis, plus tree-sitter parsing across languages. Roughly 2× the work, weaker demo, needs an IDE integration to be convincing |
| Not Track 01 (enterprise ontology) | ~500k noisy docs; entity resolution without vector support means candidate blocking happens outside the DB, so the intellectual work sits outside HydraDB — directly undercutting the "use of HydraDB" judging criterion. Plus LLM extraction cost at that volume |
| Not Track 03 (agent memory) | "Ace the benchmarks" means you need reportable numbers. LongMemEval at 115k tokens/question × hundreds of questions × multiple eval iterations is substantial API spend and many hours of runtime. Most crowded track. No vector support to build on |
| npm only, not PyPI | Halves ingest work for near-zero loss in demo impact |
| Bounded depth 6 | Forced by HydraDB's bounded-path-only traversal. Defensible: real blast radius overwhelmingly sits inside 6 hops. State it openly |
| Concrete `RESOLVES_TO` edges precomputed at ingest | Cypher cannot evaluate semver. Non-negotiable |
| Dev dependencies excluded from `RESOLVES_TO` | They do not propagate to consumers. Including them would inflate results dishonestly and knowledgeable judges would spot it |
| MIT license for Kessler | Network-boundary use of an AGPL service. See Section 10 |
| Single track entry | Multi-track entry with five days left is how you get two unfinished repos |

**Realistic prize target: the $500 Best Use of HydraDB**, which is judged separately, can go to
any entry, and rewards graph modelling specifically. Winning a track means beating everyone in
it. Optimise the submission for the graph-modelling story, not for feature count.

---

## 12. Schedule and status log

Deadline: **Aug 21, 08:59 CEST**. Submit by **Aug 20 midday PT / 21:00 CEST** — the extra
morning is insurance, not schedule.

| Day | Target | Status |
|---|---|---|
| **Aug 15** | Gate 0 cleared. Kessler repo initialised, MIT license, README skeleton committed. Ingest scraper written while Rust compiles | ☐ |
| **Aug 16** | Ingest pipeline end to end. 1k packages loaded, then scale toward 5–10k. Graph model locked | ☐ |
| **Aug 17** | `RESOLVES_TO` resolution correct. All five queries in Section 8 returning correct results via curl | ☐ |
| **Aug 18** | API endpoints + frontend. `package-lock.json` upload working. Path visualisation | ☐ |
| **Aug 19** | Deploy (timeboxed 2h), README complete, **record and edit video** | ☐ |
| **Aug 20** | Buffer + submit. Open every link yourself before submitting | ☐ |

**Record the video on the 19th, not the 20th.** Running out of time at the video stage is the
single most common way solo entrants lose.

### Status log

Append an entry per session: date, what was attempted, what worked, what broke, what changed
in Section 3.2.

```
### 2026-08-15
- Attempted: Gate 0 environment, repo init, ingest pipeline stages 1-4, hero video bake,
  landing + app shell.
- Worked:
    * Environment: host Ubuntu distro was WSL **1**, not WSL2 — converted in place
      (~70 min). Now /dev/sdb on the WSL2 kernel, 4 cores, 6.1 GB RAM, 234 GB free.
      Rust 1.95.0 present, just installed, hydradb cloned at 6a2fbb1 (Aug 13).
    * §3.5 property indexes ANSWERED: no DDL exists at all. Not a gap in the docs —
      indexes are canonical SlateDB records maintained by graph-indexer. Nothing to
      create. See §3.2.
    * Vector support VERIFIED ABSENT (embedding/hnsw/cosine = 0 hits; all 155 "vector"
      hits are GraphBLAS internals).
    * Ingest stages 1-4 written and run end to end on a 600-package graph: 6,659
      versions, 38,047 DECLARES, 10,678 RESOLVES_TO. Both resolution strategies work
      (latest-satisfying-now 89.3%, point-in-time 79.8%).
    * Video: 11.4 MB -> 2.48 MB, seamless crossfade loop, luminance inside the design band.
- Broke:
    * DESIGN.md §8.3 was wrong twice — the footage does not loop (0.677 SSIM at the seam)
      and brightness=-0.22 crushed it below the page ground. Both corrected in that file.
    * Typosquat detection is structurally blocked, not buggy — see §6.1 item 5.
- Model/plan changes:
    * MAX_VERSIONS truncation keeps the NEWEST n versions, which actively fights
      point-in-time resolution: old dependents need old targets that were not kept. That is
      why point-in-time scores 10 points lower. If point-in-time ships, the version
      selection policy has to change with it.
    * Landing page and instrument split into two surfaces so the landing can animate
      without breaking DESIGN.md §2/§7 on the data surface.
- Next: apt toolchain (needs sudo, blocked on user), then just native-check / smoke /
  node / round trip. Gate 0 is NOT yet cleared.
```

---

## 13. Submission checklist

**Repo**
- [ ] Public
- [ ] No commits before Aug 12, 2026
- [ ] MIT `LICENSE` file present
- [ ] README: what it is, setup, run instructions
- [ ] README: **how HydraDB is used and what the project would lose without it** — judges ask this explicitly
- [ ] README: honest statement of the graph's scope bound (package count, depth 6, dev deps excluded, semver strategy)
- [ ] README: attribution for npm registry data, `semver`, `neo4j-driver`, any dataset
- [ ] Env/dependency requirements documented, including the WSL/Docker requirement and `RUST_MIN_STACK`

**Video — ≤3:00, scripted**
- [ ] 0:00–0:20 the problem: one compromise, six minutes, how many services exposed
- [ ] 0:20–0:50 what Kessler is, graph model on screen
- [ ] 0:50–2:10 live demo: upload lockfile → blast radius → introduction point → maintainer overlap → typosquats
- [ ] 2:10–2:45 **the `algo.MSpaths` argument** — one server-side many-source traversal vs N client round trips, with the timing number. This is the segment that wins the special award
- [ ] 2:45–3:00 what it would lose without HydraDB
- [ ] Unlisted YouTube is fine; **open the link in a private window to confirm access**

**Form**
- [ ] Every field completed
- [ ] Repo, video, and demo links each opened and verified by you
- [ ] Submitted before Aug 20, 23:59 PT

---

## 14. How to work with the user

- He is a solo full-stack Web3 dev: Solidity/Foundry, React/TS, Node/TS, Railway, Vercel.
  Windows + Git Bash. Strong on protocol and data modelling; this hackathon's weak point for
  him is product storytelling, so **defend time for the video and README** — they carry as much
  weight as the code.
- He has explicitly asked for pushback over agreement. If a plan in this document turns out to
  be wrong once you have real results, say so directly and propose the alternative. Do not
  work around a broken assumption silently.
- He tends to propose broad scope. Section 6.2 exists to be quoted back.
- If Gate 0 fails or the schedule slips past Aug 18 with queries still not working, raise the
  abort question rather than pushing through — a clean withdrawal beats a broken submission.
