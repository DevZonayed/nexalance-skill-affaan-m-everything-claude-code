# Code Graph Memory (Layer 1)

Status: approved design, not yet implemented
Date: 2026-08-09

## Capability

An agent can answer structural questions about a codebase — does this symbol
exist, what does this file contain, what imports it, what breaks if I change it,
where are all the HTTP routes — by querying a deterministic local index instead
of reading source files. The index is built by parsers, never by a model, so
building it consumes no tokens. Querying it costs roughly 35–90 tokens where
reading the equivalent files costs 1,200 or more.

The index is trustworthy enough to replace file reads because it can never
return a confident wrong answer: every answer is verified against the current
file content before it is returned, and the interface distinguishes "I checked
and it is absent" from "I do not know."

## Position in the wider memory system

This is Layer 1 of four. Each layer is independently useful and shippable, and
later layers depend on earlier ones.

| Layer | Name | Depends on |
|---|---|---|
| 1 | Code graph memory (this spec) | nothing |
| 2 | Decision provenance | Layer 1 |
| 3 | User soul / behavioural model | Layer 2 |
| 4 | Autonomy gate (act vs ask) | Layers 1–3 |

Layer 1 is deliberately first because it has no security surface: it derives
facts from source code the operator already controls, holds no model of the
operator, and grants the agent no authority it did not already have.

### Relationship to existing ECC systems

- **Memory Vault (`ecc.memory.v1`, `docs/design/ecc-memory-vault.md`).** The
  vault stores operator-authored context. The code graph stores derived facts
  about source code. They are separate stores with separate lifecycles: vault
  documents are create-only and human-reviewed, graph shards are disposable and
  fully rebuildable. Layer 2 will link the two by referencing vault decision IDs
  from graph history events.
- **`continuous-learning-v2`.** Unrelated at Layer 1. It models operator
  behaviour; this models source code.
- **`smart-explore`, `repo-scan`, `code-tour`.** These perform live analysis and
  emit prose for a human or a single session. The code graph is a durable,
  queryable index. It does not replace them.

### Constraint inherited from the Memory Vault design

> Markdown files are the source of truth. SQLite context graphs, embeddings,
> and hosted systems are indexes or adapters, never the only copy.

The graph honours the spirit of this constraint: JSON shards on disk are the
source of truth, they are human-readable and diffable, and any derived index is
rebuildable from them.

## Constraints

- No native compilation. Parsing uses WASM tree-sitter, matching the existing
  `sql.js` precedent. `npm install` must continue to work with no compiler
  toolchain on Windows, macOS and Linux.
- **Pinned, verified dependency pair:** `web-tree-sitter@0.22.6` plus
  `tree-sitter-wasms@0.1.13` (grammar ABI 14). This exact pair was probed on
  2026-08-09: all four target grammars load, parse and answer queries. Newer
  runtimes are **not** drop-in — `web-tree-sitter@0.26.12` fails to load these
  grammars with a `getDylinkMetadata` error, because `tree-sitter-wasms` builds
  its `.wasm` files with `tree-sitter-cli@0.20.x` and the Emscripten dylink
  format has since changed. Both versions must be upgraded together, behind the
  parser fixture suite.
- Node >= 18, CommonJS, no transpilation, consistent with `.claude/rules/node.md`.
- No model is invoked at any point in building, updating, or querying the index.
- The index is disposable. Deleting `.ecc/graph/` must never lose information
  that cannot be regenerated from the working tree.
- Hooks must never block or fail an edit. All hook paths exit 0.
- Query output is a token budget. Default output is terse; verbosity is opt-in.

## Non-goals

- Semantic or embedding-based search. Lookup is exact-name and structural.
- Type checking, linting, or correctness analysis. This is an index, not a
  compiler.
- Cross-repository indexing. One index per repository.
- Indexing languages outside the supported set. Unsupported files are reported
  as unindexed, never guessed at.
- Replacing `git`. The graph stores structural deltas, not file contents.
- Any model-authored content in the index.

## Scope

**Languages (v1):** TypeScript/JavaScript (including TSX/JSX), Python, Rust, Go.

Chosen because they cover this repository (520 JS/TS, 63 Python, 17 Rust files
tracked today) and the majority of ECC's language rules. Additional languages
are added behind the same parser interface, one at a time, with no schema change.

## Architecture

```text
.ecc/graph/
├── manifest.json          languages, entrypoints, rev, counts, coverage
├── files/<pathhash>.json  per-file detail, one shard per source file
├── index/
│   ├── symbols.json       symbol name → [refs]        (O(1) find)
│   ├── kinds.json         kind        → [refs]        (O(1) list)
│   └── edges.json         forward and reverse import edges
└── history/events.jsonl   append-only structural changelog
```

`.ecc/graph/` is generated, machine-local, and gitignored by default. It is
regenerable from the working tree at any time.

### Components

Four modules with narrow interfaces, each testable in isolation.

| Module | Responsibility | Depends on |
|---|---|---|
| `detector` | Identify languages and entrypoints from `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, and file extensions | nothing |
| `parser` | Given a file path and language, produce a shard object: symbols, signatures, doc comments, imports, kind tags | `detector` |
| `store` | Read/write shards atomically, maintain the three derived indexes, verify content hashes, append history events | `parser` |
| `query` | Implement the `ecc graph` verbs, enforce the staleness check and the exit-code contract | `store` |

Boundaries: `parser` never touches disk layout; `store` never parses; `query`
never writes shards except through `store`'s heal path. A new language is a new
`parser` grammar registration and nothing else.

### Data flow: full build

1. `detector` scans the repo, returns languages present and entrypoints.
2. For each matching file, `parser` produces a shard.
3. `store` writes shards, rebuilds `index/*`, writes `manifest.json`.
4. If a prior index existed, `store` diffs old against new shards and appends
   structural events to `history/events.jsonl`.

### Data flow: query

1. `query` loads the relevant index file.
2. It resolves candidate refs (typically one to three files).
3. For each candidate file it stats and hashes the file on disk.
4. Hash matches stored hash — answer is returned.
5. Hash differs — `store` reparses that single file, updates its shard and the
   indexes, appends any events, then answers from the healed data.

Measured on this repository (46 files, 434 KB of `scripts/lib/*.js`, 2026-08-09):
parse and symbol extraction cost **4.45 ms mean per file, 19.7 ms worst case**.
A 600-file full build is therefore roughly **2.7 s of parse time**, plus I/O and
index serialisation. Single-file heal is imperceptible inside a CLI invocation.

This is what makes a confidently wrong answer structurally impossible: an answer
is only ever emitted from a shard whose hash was verified against disk in the
same invocation.

### Data flow: incremental update

`PostToolUse` on `Edit` and `Write` reparses the one affected file, diffs it
against the existing shard, rewrites the shard, patches the three indexes, and
appends events. Work is bounded by the size of one file. On any error the hook
marks the shard dirty and exits 0; the next query heals it.

Files changed outside the agent's write path — `git checkout`, `git pull`,
rebase, an external editor — are caught by the query-time hash check rather than
by the hook. No watcher process is required.

## Schemas

### File shard — `ecc.graph.file.v1`

```json
{
  "schema": "ecc.graph.file.v1",
  "path": "src/config.ts",
  "lang": "typescript",
  "hash": "sha256:9f8e7d6c...",
  "rev": 47,
  "status": "indexed",
  "doc": "Configuration loading and validation.",
  "imports": [
    { "from": "./env", "resolved": "src/env.ts", "symbols": ["loadEnv"], "line": 3 },
    { "from": "node:fs", "resolved": null, "external": true, "line": 1 }
  ],
  "exports": ["parseConfig", "ConfigError"],
  "symbols": [
    {
      "name": "parseConfig",
      "kind": "function",
      "line": 42,
      "end_line": 78,
      "signature": "(path: string, opts?: Opts) => Config",
      "doc": "Parse a config file and validate required keys.",
      "exported": true,
      "calls": ["loadEnv", "validate"]
    }
  ]
}
```

`status` is one of `indexed`, `parse_error`, `not_indexed`.

Design decisions:

- **`hash` is a sha256 of file content, not mtime.** Git sets mtime to checkout
  time, so mtime reports spurious changes on branch switches and can miss real
  changes after some restore operations. Content hashing is definitive. Full-repo
  hashing happens only on build; queries hash only the files they answer from.
- **`doc` appears at file and symbol level.** This is the leading comment or
  docstring. It is what allows `find` output to explain itself without opening
  the file.
- **`calls` per symbol** enables symbol-level impact analysis rather than
  file-level only.
- **Shard filenames are a hash of the repo-relative path**, avoiding Windows
  path-length limits and charset issues.

### Derived indexes

All three are rebuildable from shards; corruption is recoverable, never fatal.

```jsonc
// index/symbols.json — the value is a LIST. Names collide constantly.
{
  "schema": "ecc.graph.symbols.v1",
  "rev": 47,
  "symbols": {
    "parseConfig": [
      { "path": "src/config.ts", "line": 42, "kind": "function", "exported": true }
    ]
  }
}

// index/kinds.json
{
  "schema": "ecc.graph.kinds.v1",
  "rev": 47,
  "kinds": {
    "http-route": [ { "path": "src/routes/auth.ts", "line": 12, "label": "POST /api/auth" } ]
  }
}

// index/edges.json — reverse edges are precomputed, making `impact` O(1)
{
  "schema": "ecc.graph.edges.v1",
  "rev": 47,
  "out": { "src/main.ts": ["src/config.ts", "src/auth.ts"] },
  "in":  { "src/config.ts": ["src/main.ts", "src/cli.ts"] }
}
```

### Manifest — `ecc.graph.manifest.v1`

```json
{
  "schema": "ecc.graph.manifest.v1",
  "rev": 47,
  "built_at": "2026-08-09T12:00:00.000Z",
  "git_sha": "a1b2c3d",
  "languages": [ { "lang": "typescript", "files": 520, "grammar": "0.21.0" } ],
  "entrypoints": ["src/main.ts", "scripts/ecc.js"],
  "counts": { "files": 600, "symbols": 1902, "edges": 2418 },
  "unindexed": { "unsupported": 2848, "parse_error": 3 }
}
```

The `unindexed` block is required. This repository tracks 3,448 files of which
roughly 600 are indexable; stating that plainly prevents the graph from being
mistaken for complete coverage.

### History events — `ecc.graph.event.v1`

Append-only JSONL. One line per structural change.

```json
{ "schema": "ecc.graph.event.v1", "rev": 48, "sha": "9f8e7d6",
  "at": "2026-08-09T12:05:00.000Z", "op": "signature.changed",
  "path": "src/config.ts", "symbol": "parseConfig",
  "from": "(p: string)", "to": "(p: string, o?: Opts)", "decision": null }
```

`op` is one of `symbol.added`, `symbol.removed`, `symbol.renamed`,
`signature.changed`, `edge.added`, `edge.removed`, `file.added`, `file.removed`.

`decision` is always `null` in Layer 1. It exists so Layer 2 can join structural
change to a vault decision ID without a schema migration.

The log stores structural deltas only. It does not duplicate git; it answers
questions git can only reconstruct by walking full history, such as "when did
this function disappear."

## Symbol taxonomy

Every symbol carries a `kind`. Kinds are split into two tiers, and the tier
determines what the exit-code contract may claim.

**Structural kinds** — derived directly from the AST, exhaustive and reliable:
`function`, `method`, `class`, `interface`, `type`, `enum`, `const`, `module`.

**Heuristic kinds** — derived from framework conventions layered on the AST,
best-effort and not exhaustive:

| Kind | Detection |
|---|---|
| `react-component` | TS/JS: exported function or const whose body returns JSX |
| `react-hook` | TS/JS: function matching `^use[A-Z]` |
| `http-route` | Express/Fastify `app.<verb>(...)`; FastAPI/Flask decorators; Axum `Router::route`; Gin `r.<VERB>` |
| `cli-command` | Commander/yargs registrations; `argparse` subparsers; `clap` derives; `cobra` commands |
| `test` | Jest/Vitest `describe`/`it`/`test`; Python `def test_*`; Rust `#[test]`; Go `func Test*` |
| `error-type` | Class or type extending/implementing a language error base |

**Contract consequence:** a `list --kind` query over a heuristic kind may return
an empty or incomplete result without that meaning the kind is absent. Heuristic
kinds therefore never produce exit code `1` (definitively absent) — only `0` or
`3`. Structural kinds may produce `1`.

## CLI surface

Nine verbs under `ecc graph`. All accept `--json`. Default output is terse.

| Verb | Purpose |
|---|---|
| `build [--force]` | Full index build |
| `find <symbol> [--kind K] [--exported]` | Existence, location, signature |
| `file <path>` | File summary: doc, imports, exports, symbols |
| `deps <path> [--reverse] [--depth N]` | Imports, or importers |
| `impact <path\|symbol>` | Transitive reverse dependencies and covering tests |
| `list --kind <k> [--path glob]` | Taxonomy query |
| `history <symbol\|path>` | Structural changelog for a target |
| `doctor [--json]` | Health, staleness, coverage gaps |
| `status` | One-line summary for SessionStart injection |

### Representative output

```text
$ ecc graph find parseConfig
src/config.ts:42  function  parseConfig(path: string, opts?: Opts) => Config  [exported]
  Parse a config file and validate required keys.
```

```text
$ ecc graph file src/config.ts
src/config.ts  typescript  4.8KB  rev47  fresh
doc: Configuration loading and validation.
imports: ./env(loadEnv), node:fs, ajv
exports: parseConfig, ConfigError
  42  function  parseConfig(path, opts?) => Config    Parse a config file and validate...
  88  class     ConfigError extends Error             Thrown when required keys are absent.
```

```text
$ ecc graph status
graph: 600 files, 1902 symbols, rev 47, fresh (3 parse errors, 2848 unsupported)
query before reading files: ecc graph find|file|deps|impact|list
```

### Exit-code contract

| Code | Meaning | Agent behaviour |
|---|---|---|
| `0` | Answered | Trust the answer |
| `1` | Definitively absent: index fresh, structural kind, symbol not present | Trust the answer |
| `2` | Index unavailable, corrupt, or unrecoverably stale | Read the files |
| `3` | Target file or language not indexed; or a heuristic-kind query returned no results, which does not prove absence | Read the files |

The separation of `1` from `2` and `3` is the core safety property. "I checked
and it is not there" and "I do not know" must never be conflated, because that
conflation is how an index begins causing defects rather than preventing them.

## Integration surface

- **CLI:** `ecc graph <verb>`, registered in `scripts/ecc.js`, implemented under
  `scripts/graph/`, shared helpers in `scripts/lib/`.
- **Hook:** `scripts/hooks/graph-update.js`, routed through
  `scripts/hooks/run-with-flags.js` for `ECC_HOOK_PROFILE` and
  `ECC_DISABLED_HOOKS` gating, registered on `PostToolUse` for `Edit|Write`.
- **SessionStart:** existing bootstrap emits the `graph status` line, roughly 40
  tokens, only when an index exists.
- **Skill:** `skills/code-graph/SKILL.md` teaches when to query instead of
  reading, following the repository's When to Use / How It Works / Examples
  format.
- **No new MCP server.** ECC adopted a single-connector MCP policy in v2.0.0 and
  this feature does not justify an exception.

## Error handling

Every failure path degrades to "read the file," never to a guess.

| Failure | Behaviour |
|---|---|
| File fails to parse | Shard written with `status: parse_error`; counted in manifest; queries return `3` |
| Unsupported language | Never indexed; queries return `3` |
| Index missing or corrupt | Queries return `2` with a rebuild hint; `doctor` reports it |
| Hook failure | Logs to stderr with a `[GraphUpdate]` prefix, marks shard dirty, exits 0. Never blocks the edit |
| Concurrent writes | Shard writes are atomic: write to a temp file, then rename |
| Hash mismatch at query time | Reparse that file, heal, then answer |
| Repo has no supported language | `build` writes a manifest with zero counts; `status` prints nothing at SessionStart |

## Testing

Per `.claude/rules/node.md`, tests live in `tests/` mirroring `scripts/`, named
`*.test.js`, and run under `node tests/run-all.js`.

1. **Parser fixtures.** A small fixture repository per language with known
   symbol, import and kind counts. Asserts exact extraction, including doc
   comments and signatures.
2. **Staleness suite.** Mutates files behind the index's back — edit, delete,
   rename, `git checkout` — then asserts the query heals and never returns a
   stale answer. This is the suite that protects the core safety property.
3. **Exit-code suite.** Asserts each of `0`, `1`, `2`, `3` is produced in the
   right circumstance, including that heuristic-kind queries never return `1`.
4. **Event-log golden tests.** A known sequence of edits produces an exact
   expected event stream.
5. **Incremental-equivalence property.** For a random sequence of edits, the
   incrementally updated index must be byte-identical to a full rebuild. This is
   the single highest-value test in the suite.
6. **Token-budget assertions.** `find` and `file` output must stay under fixed
   ceilings. If output grows past them the feature has lost its purpose, so the
   ceiling is enforced as a test.
7. **Hook integration test.** Confirms the hook exits 0 on malformed input, on
   parse failure, and on a read-only `.ecc/` directory.
8. **Cross-platform path handling.** Windows path separators, long paths, and
   non-ASCII filenames.

## Open questions

These do not block implementation and are deliberately deferred.

- Whether `impact` should traverse dynamic imports and dependency-injection
  wiring, which are not statically resolvable in the general case. v1 reports
  static edges only and says so in the output.
- Whether monorepo workspaces should produce one index or one per package. v1
  produces one index at the repo root.
- Whether `.ecc/graph/` should be gitignored by default or optionally committed
  for CI reuse. v1 gitignores it; committing it would require resolving
  machine-dependent absolute path leakage first.
- Which additional language is added first after v1, and whether grammar `.wasm`
  files should be bundled in the npm package or downloaded on first build. v1
  bundles them; the package-size impact is roughly 6–8 MB.
- How to move off the pinned `web-tree-sitter@0.22.6`. The current runtime is
  0.26.x, so v1 ships a deliberately old parser runtime. The upgrade requires a
  grammar source built against a matching Emscripten dylink format — either a
  newer prebuilt-grammar package, or building `.wasm` grammars with
  `tree-sitter-cli` at package-publish time. The latter keeps installs
  compiler-free but adds an Emscripten toolchain to the maintainer's release
  process. This is not urgent: grammar ABI 14 parses these four languages
  correctly today, and the parser fixture suite will catch any regression on
  upgrade.

## Handoff

Implementation proceeds module by module in dependency order: `detector`,
`parser`, `store`, `query`, then CLI registration, then the hook, then the
skill. Each module lands with its tests. The incremental-equivalence property
test gates the hook: the hook is not registered until incremental updates are
proven identical to full rebuilds.
