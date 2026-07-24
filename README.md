# ⛧ pentagram

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
recall surfaces the fact; `(provenance id)` walks back to the evidence. The v0
summarizer is extractive; an LLM summarizer plugs in behind the same event
shape.

The library surface is exported from `src/index.ts` (`Store`, `memoryEnv`,
`evaluate`, `read`, `print`, embedders).

## Status & roadmap

v0.2 implements the language (with `defmacro`/quasiquote), the two-layer store,
semantic recall, reinforcement and decay, consolidation with provenance,
procedural replay, a REPL, and the MCP server. Still honest about its gaps:

- Recall is a full scan. Fine to ~10⁵ episodes; add an ANN index (HNSW) after.
- The log is one text file, single-writer. Then: segmentation, snapshots, and
  columnar (Parquet) compaction of the cold tail for the analytical layer.
- `replay`/`eval` are unsandboxed — single-user, trusted-agent deployments
  only until capabilities and resource limits land.
- Planned next: LLM summarizer for consolidation, entity layer, importance
  scoring in recall, multi-tenant isolation.
