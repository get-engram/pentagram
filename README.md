# ⛧ pentagram

[![ci](https://github.com/get-engram/pentagram/actions/workflows/ci.yml/badge.svg)](https://github.com/get-engram/pentagram/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pentagram-db)](https://www.npmjs.com/package/pentagram-db)

A homoiconic memory substrate for AI systems. No database underneath, no
dependencies, no impedance layers: the query language, the data model, and the
on-disk format are all the same thing — S-expressions.

The full design argument — motivation, principles, architecture, the
quantum-inspired foundations, related work, and evaluation plan — is in the
[design paper](docs/paper.md).

```lisp
⛧ (remember "warehouse costs are dominated by idle compute credits")
"1f3a9c2e"
⛧ (recall "why are warehouses expensive")
(("1f3a9c2e" 0.61 "warehouse costs are dominated by idle compute credits"))
⛧ (remember '(lambda (n) (* n n)))     ; a memory can be a program
"8b2d11f0"
⛧ ((replay "8b2d11f0") 9)              ; recall it by running it
81
```

## Design

Two layers, deliberately asymmetric:

- **Exact layer** — an append-only log of S-expressions on disk. Every event
  (`episode`, `link`, `recalled`, `forget`) is one immutable line. The log is
  the database, the audit trail, and valid Lisp. Truth lives here, forever.
- **Associative layer** — derived by folding the log: embeddings, trace
  strength, the link graph. Mutable, reconstructable from scratch, and shaped
  by use.

Five principles (one per point):

1. **Code is data is memory.** A stored memory can be an expression; `replay`
   evaluates it with the same evaluator that runs the REPL. Storage holds
   programs about the data — the Kolmogorov ideal of compression.
2. **Observation is a write.** Recalling a memory reinforces it: recall events
   append to the log and raise trace strength. The store learns from being
   queried (reconsolidation, not quantum collapse — reads reorganize
   information, never destroy it).
3. **Forgetting is a feature.** Recency decays on a half-life; `(decay!)`
   tombstones weak, stale traces. Tombstones are events too — the exact layer
   never loses anything, the associative layer stops surfacing it.
4. **Three access paths, one substrate.** Similar (embedding cosine), connected
   (`link` / `hops` traversal), and exact (the log itself). Recall scores
   `similarity × recency × strength`.
5. **No engine underneath.** Pure TypeScript, zero runtime dependencies. Every
   limitation is ours to remove.

## Use

```sh
npm install
npm run smoke           # end-to-end test: language, macros, memory, graph,
                        # replay, consolidation, persistence (offline, hash embedder)
npm run semantic-check  # exercises the real MiniLM embedder (downloads ~25 MB once)
npm run repl            # interactive; state persists in memory.pgram
npm run mcp             # MCP server on stdio — pentagram as agent memory
```

**Embeddings.** Recall uses all-MiniLM-L6-v2 running locally via
transformers.js when available (an optional dependency — no API key, model
cached after first download) and falls back to the zero-dep hash embedder
otherwise. Embeddings are derived state, cached in a sidecar
(`<log>.vecs.json`) tagged by embedder — switching embedders just re-derives
the associative layer.

**MCP.** `npm run mcp` (or `npx tsx src/mcp.ts`) speaks Model Context Protocol
over stdio with tools `remember`, `recall`, `link`, `hops`, `stats`, and `eval`
(the full language — the agent protocol *is* the language). Configure with
`PENTAGRAM_LOG` and `PENTAGRAM_EMBEDDER=semantic|hash`. For Claude Code:
`claude mcp add pentagram -- npx tsx /path/to/pentagram/src/mcp.ts`.

**Macros.** The language grows itself:

```lisp
⛧ (defmacro unless (c body) `(if ,c () ,body))
⛧ (unless false 42)
42
```

**Consolidation.** `(consolidate!)` clusters old, similar episodes and
compresses each cluster into a `fact` carrying provenance — the ids of the
episodes it summarizes, which stay in the log forever. Sources are tombstoned;
recall surfaces the fact; `(provenance id)` walks back to the evidence.
Summarizers are pluggable: `extractiveSummarizer` (offline default) or
`claudeSummarizer` (shells out to the `claude` CLI headless — no SDK, no API
key handling; uses the CLI's auth). The MCP server auto-selects
(`PENTAGRAM_SUMMARIZER=claude|extractive` to force).

**Entities.** `(entity "acme corp" 'client)` creates (or returns — deduped by
name+kind) a first-class graph node: recallable like any memory, immune to
decay, and connectable with `(mention episode-id entity-id)`. Every mention of
the same entity converges on one node, so `hops` from an entity walks its
whole history.

**Sandboxed replay.** `(replay id)` evaluates stored code in a language-only
environment — no memory operations reachable. `(replay! id)` deliberately
escalates to full access for trusted code; the `!` is the audit trail in the
source.

**Entity extraction.** `(extract!)` mines named entities from unprocessed
episodes and wires `mentions` links — the graph builds itself from raw text.
The LLM extractor (`claudeExtractor`) prompts the claude CLI to reply in
S-expressions, parsed by pentagram's own reader. Passes are incremental
(`extracted` markers) and capped per batch.

**The sleep cycle.** `(sleep!)` runs decay → extract → consolidate in one
pass — forget the stale, mine structure from the new, compress the similar.
The MCP server schedules it with `PENTAGRAM_SLEEP=<minutes>` (off by default;
scheduling LLM calls is an explicit choice), and exposes it as a `sleep` tool.

**Log segmentation.** When the active log exceeds 10 MB (configurable via
`StoreOptions.maxLogBytes`), it is archived intact — the exact layer never
loses history — and replaced by a compact snapshot of live state (episodes,
facts, entities, links, trace summaries). Loads read snapshot + tail instead
of all of history; archives remain on disk for audit and provenance.

**External provenance & revision.** Pentagram can sit *over* existing systems
of record without copying them: a fact is a **claim with pointers**, and its
provenance may mix episode ids with structured external references —
`(fact! "acme's balance was disputed" '((postgres "invoices/1234" 1755212000000)))`.
Recall surfaces the claim; `(sources id)` gives the address to dereference for
the exact current value. When the world changes, `(revise! id "new text" refs)`
supersedes the belief: the successor takes over recall, the predecessor is
tombstoned but never deleted, and `(history id)` walks the chain — "what did
the system believe on March 3rd, and why?" is a query, not a forensics project.

**Parquet compaction.** `(compact!)` converts archived segments to Parquet
(optional `hyparquet-writer` dependency): typed columns for the common
queries plus a `raw` column holding every original S-expression line, so the
conversion is lossless. The cold tail joins the composable stack — DuckDB,
Spark, anything that reads Parquet can query pentagram's history in place.

**Multi-tenant isolation.** `Tenants` gives each tenant a fully separate
store — own log, own lock, own caches, own evaluation environment. Isolation
is structural: a tenant's builtins close over that tenant's store and cannot
name any other. Every MCP tool takes an optional `tenant` argument; validated
names (`[a-z0-9][a-z0-9_-]{0,63}`) are the path-safety boundary.

The library surface is exported from `src/index.ts` (`Store`, `memoryEnv`,
`evaluate`, `read`, `print`, embedders).

**Scale.** Recall scores `similarity² × recency × strength × importance` —
similarity squared so relevance dominates and usage signals break near-ties
(the linear formula measurably lost to bare similarity; see
[docs/eval.md](docs/eval.md)). Strength grows log-damped with use: passive
recall reinforces what surfaces, and `(touch! id)` is the agent's explicit
"this one mattered" (worth 3 recalls). Importance grows with link degree.
Small stores use an exact scan; past 2,000 live memories a pure-TypeScript
HNSW index builds automatically (`npm run bench`: ~4x faster at 5k episodes
with ~86% top-10 agreement vs exact, and the gap widens with size — scan is
O(N), HNSW ~O(log N)). The index is derived state like everything else:
never persisted, rebuilt at need, tombstones filtered at search time.

## Status

v0.6 completes the design paper's scope: the language (with
`defmacro`/quasiquote), the two-layer store, semantic recall with importance
scoring, reinforcement and decay, LLM-backed consolidation and entity
extraction, the sleep cycle, log segmentation with snapshots, Parquet
compaction of archives, sandboxed procedural replay, automatic HNSW indexing,
enforced single-writer locking, multi-tenant isolation, a REPL, and the MCP
server. Remaining by-design boundaries:

- Single-writer per store: the lockfile makes concurrent opens fail fast;
  shared concurrent writing is out of scope for the file backend.
- The MCP `eval` tool has full access *within its tenant* — the agent
  protocol is the language; cross-tenant access is structurally impossible,
  in-tenant `eval` is deliberately unrestricted.

Pentagram is a standalone open-source framework (MIT): it depends on no
product, and no product depends on it.
