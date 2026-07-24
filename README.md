# ⛧ pentagram

A homoiconic memory substrate for AI systems. No database underneath, no
dependencies, no impedance layers: the query language, the data model, and the
on-disk format are all the same thing — S-expressions.

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
npm run smoke   # end-to-end test: language, memory, graph, replay, persistence
npm run repl    # interactive; state persists in memory.pgram
```

The library surface is exported from `src/index.ts` (`Store`, `memoryEnv`,
`evaluate`, `read`, `print`).

## Status & roadmap

v0 is a working skeleton, honest about its placeholders:

- The embedder is hashed trigrams — deterministic and offline, not semantic.
  Swap in a real embedding model behind `embed()`.
- Recall is a full scan. Fine to ~10⁵ episodes; add an ANN index (HNSW) after.
- The log is a text file. Fine until it isn't; then segment + snapshot +
  columnar compaction for the analytical tail.
- Planned: macros (`defmacro`), consolidation (background summarization of
  episodes into semantic facts — sleep as ETL), provenance-carrying facts,
  entity layer, multi-tenant isolation.
