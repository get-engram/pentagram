# Pentagram: A Homoiconic Memory Substrate for AI Systems

**Draft v0.1 — July 2026**
D. Gail, get-engram

---

## Abstract

AI systems need memory, and the systems we store data in were not designed for the way memory is used. Agent memory queries blend four operations that today live in four different products: semantic similarity (vector databases), relationship traversal (graph databases), temporal and aggregate analytics (warehouses), and exact auditable record (transactional logs). Running all four means running several databases plus the synchronization pipelines between them — recreating, at the level of a single application, the two-copies problem that the lakehouse architecture spent a decade eliminating at the level of the enterprise.

Pentagram is a design and a working prototype for a single memory substrate with a deliberately asymmetric two-layer architecture: an **exact layer** — an append-only log of S-expressions that is simultaneously the database, the audit trail, and a valid program — and an **associative layer** derived entirely by folding that log: embeddings, trace strength, and a link graph, mutable and reconstructable from scratch. The substrate is *homoiconic*: the query language, the data model, the persistence format, and the agent protocol are all the same representation. Three further principles complete the design: recall reinforces what it touches (observation is a write), forgetting is a scheduled feature rather than a failure, and a stored memory may be a program, evaluated at recall time (procedural, generative storage). We describe the design, its intellectual lineage — dimensional warehousing, Datomic's accumulate-only model, hyperdimensional computing, and the dequantization literature — and the honest limits of the current prototype.

---

## 1. Motivation

### 1.1 The workload

Consider the queries an AI agent with persistent memory actually issues:

> *Find memories similar to this situation, involving this person or anything connected to them within two hops, weighted toward the recent past, and summarize them by project.*

That single query is a vector search, a graph traversal, a temporal filter, and an aggregation. No mainstream system executes it as one operation. The current practice — a vector store for similarity, a graph or relational store for entities, an event log somewhere else, and application code stitching them per-query — has three well-known failure modes: the stores drift out of sync, the stitching logic becomes an unowned query planner, and no single component holds the full truth needed for audit or replay.

### 1.2 The gap in the market

The database industry has approached this gap from every side without landing in the middle. General engines grew vector capabilities (pgvector, DuckDB `vss`, ClickHouse vector indexes) but treat memory semantics — reinforcement, decay, provenance — as application concerns. Graph databases added vectors (Kuzu) but lack analytical depth. Vector-native storage (LanceDB) lacks traversal. The multi-model generation of the 2010s (ArangoDB, OrientDB) demonstrated the failure mode to avoid: several half-good engines behind one API, mediocre at everything. The pattern that has worked historically is the opposite: **one storage substrate, many specialized indexes** — and that is the pattern pentagram adopts.

### 1.3 Why not assemble it from parts?

An earlier iteration of this project planned exactly that: Lance or Parquet storage, an embedded SQL engine, an ANN library, edge tables. The composable data stack makes that assembly genuinely viable, and pentagram retains an escape hatch to it (§9). The reason to depart from it is representational, not operational: a memory substrate whose stored objects can be *programs*, whose queries can be *stored*, and whose agent protocol is its data model requires a homoiconic foundation, and no SQL engine supplies one. The choice of Lisp is not aesthetic; it is the shortest known path to a system whose core is small enough to be fully understood — and therefore whose limitations are all removable.

---

## 2. Design principles

Pentagram is organized around five commitments — one per point of the star.

**P1. Code is data is memory.** Everything in the system — stored memories, queries, the on-disk log, messages to and from agents — is an S-expression. A memory may be an inert value (`"the meeting moved to thursday"`) or an expression (`(lambda (n) (* n n))`); recall of the latter may *evaluate* it. This realizes the Kolmogorov view of storage: the ideal compressed form of data is the shortest program that regenerates it. Storage holds generators; lookup runs them.

**P2. Observation is a write.** Recalling a memory appends a `recalled` event to the log and thereby raises the memory's trace strength. Retrieval is not a pure function; the store learns from being queried. The model here is neuroscientific *reconsolidation* — recall reconstructs a memory from a compressed trace and re-stores it altered — and explicitly **not** quantum measurement, which destroys information. The invariant that keeps this principled: mutation exists only in the derived layer; reads reorganize information and never destroy it (§3.3).

**P3. Forgetting is a feature.** Trace relevance decays on a half-life; a scheduled pass tombstones traces whose computed strength falls below threshold. Tombstones are themselves log events: the exact layer never loses anything, the associative layer stops surfacing it. Forgetting is what keeps recall precision and storage cost bounded as the log grows without bound.

**P4. Three access paths, one substrate.** Similar (embedding cosine), connected (link traversal), and exact (the log itself, with temporal structure). Recall scoring composes them: `similarity × recency × strength`, with graph adjacency available as an explicit traversal operator and, in future work, as a scoring term. There are not three engines; there are three indexes over one event log.

**P5. No engine underneath.** The v0 implementation is pure TypeScript with zero runtime dependencies. This is a statement about *understandability*, not performance: every behavior of the system is in ~700 lines the maintainer can read in one sitting. Performance-critical components (the embedder, the ANN index, columnar compaction) are designed to be swapped in behind stable interfaces without surrendering the core.

---

## 3. Architecture

### 3.1 The exact layer: an append-only S-expression log

The durable state of a pentagram store is one file of S-expression events, one per line:

```lisp
(episode "df623976" 1784866516024 "warehouse costs are dominated by idle compute credits")
(link "df623976" about "404ef9d8")
(recalled "df623976" 1784866516031)
(forget "cb49cd91" 1784952916024)
```

Four event types exist in v0: `episode` (a new memory, with content that is any S-expression), `link` (a typed edge), `recalled` (a reinforcement, appended by the read path), and `forget` (a tombstone). The log is:

- **the database** — full state is recovered by folding the events in order;
- **the audit trail** — every fact about the store's history, including every recall that shaped its current weighting, is an immutable line with a timestamp;
- **a valid program** — the log parses with the same reader that parses queries, and can be transformed, filtered, or replayed by ordinary pentagram code.

This is event sourcing, chosen for the same reason Datomic chose accumulate-only semantics: an immutable history is the only substrate on which both audit ("why did the system believe X?") and time travel ("what did it believe last Tuesday?") come for free.

### 3.2 The associative layer: derived, mutable, disposable

At load, the store folds the log into in-memory state: an episode table with embeddings (computed, not stored — the log stays human-readable and the embedder swappable), a trace table (`recallCount`, `lastAccess`), and an edge list. Nothing in this layer is truth; all of it is reconstructable from the log, which means the entire layer can be discarded and rebuilt whenever its derivation changes — a new embedder, a new strength formula, a new index structure. Schema migration in the conventional sense does not exist; there is only re-derivation.

### 3.3 The read path: recall as reconsolidation

`(recall query n)` embeds the query, scores every live episode as

```
score = cosine(query, episode) × 0.5^(hours_since_access / 720) × (1 + 0.25 × recall_count)
```

returns the top *n*, and appends a `recalled` event for each — the observation-as-a-write of P2. The decay half-life (30 days) and reinforcement weight (25%) are v0 constants intended to become per-store policy. Note the division of labor that keeps P2 safe: the *scoring inputs* change with every read, but only via appended events; no stored value is ever overwritten. A pentagram store is thus deterministically replayable — fold the same log, get the same state — while still being shaped by its own usage history.

### 3.4 Procedural memory

`(remember '(lambda (n) (* n n)))` stores code; `(replay id)` evaluates it in the store's environment. This is the mechanism by which the substrate holds *generators* rather than only extensions: a memory can be a rule, a template, a summarization procedure, or a query worth re-running. Because the evaluator is the same one serving the REPL and the agent protocol, procedural memories compose with everything else in the system. (Sandboxing of replayed code — resource limits, capability restriction — is required before any multi-tenant deployment; see §8.)

### 3.5 Planned: consolidation, or sleep as ETL

The design calls for a background loop that periodically summarizes clusters of old episodes into semantic facts — compact, provenance-carrying derived memories that cite the episode IDs they compress — after which the source episodes become candidates for tombstoning. This is the biological memory pipeline (episodic buffer → sleep consolidation → semantic store) implemented as the warehouse pattern it structurally is: raw events, scheduled transformation, curated aggregates. It is also where an LLM enters the architecture, as the summarization function; v0 deliberately ships without it so that the substrate's correctness does not depend on a model.

---

## 4. The language surface

S-expressions serve four roles at once:

**Query language.** `(recall "why are warehouses expensive" 3)`, `(hops "df623976" 2)`, `(decay!)`. The evaluator is a one-page Lisp — quote, `if`, `define`, `lambda`, `let`, closures — so queries compose: `(map (lambda (r) (car r)) (recall "hosting decisions" 10))`.

**Data model.** Episode content is any expression; there is no schema to migrate, and structure (tags, fields) is convention over lists, hardened later by macros rather than by DDL.

**Persistence format.** §3.1. Reader + printer are the entire serialization stack.

**Agent protocol.** An LLM agent's interface to pentagram is: emit an S-expression, receive an S-expression. Prefix notation with balanced delimiters is among the easiest syntaxes for models to generate correctly — easier than SQL's irregular grammar — and the protocol needs no separate specification because it *is* the language. The intended deployment (an MCP server exposing `remember`/`recall`/`link` to any agent) is a thin adapter over `evaluate`.

The planned macro system (`defmacro`) extends this surface without extending the core: domain query forms — `(recent-about "topic" 7)`, `(memories-of person)` — become user-defined rewrites into the primitive five, in the language, by the language.

---

## 5. Quantum-inspired, honestly

The project's early framing asked for "a data system for AI and quantum we can start using now." The physics is unambiguous about the second half: quantum hardware cannot be a data store on any foreseeable horizon — the no-cloning theorem forbids copies (hence backups and replication), measurement is destructive (a read-once database), coherence lifetimes are microseconds, and the absence of QRAM means loading *N* classical records costs ~*N* operations, erasing the exponential speedups before they begin.

What survives is a family of *quantum-inspired classical* techniques, and pentagram's design draws on each:

1. **Superposition via high-dimensional vectors.** An embedding stores thousands of features overlaid in one object, retrieved associatively by geometric proximity — hyperdimensional computing (Kanerva) formalizes this as the classical realization of the property people actually want from quantum storage. Pentagram's associative layer is exactly this: every memory carries a superposed representation beside its exact one.

2. **Length-squared sampling.** Tang's 2018 dequantization of the Kerenidis–Prakash quantum recommendation algorithm (arXiv:1807.04271) showed that sampling data proportional to squared magnitude substitutes classically for the data-access advantage QRAM was assumed to provide. For pentagram this licenses a future *approximate* read path — sublinear sampled recall and sampled aggregates over very large logs — with the exact layer always available beneath it.

3. **Reconsolidation over measurement.** The one quantum property pentagram deliberately inverts: where measurement collapses state destructively, recall here reorganizes state constructively (P2). "Observation changes the data" is retained; information loss is not.

The claim, stated plainly: pentagram is a classical system through and through, borrowing from quantum information theory only the ideas that survive dequantization — which the last eight years of that literature suggest are most of the useful ones.

---

## 6. Relation to the two-layer thesis

This design instantiates a broader argument about where data systems are going (developed at book length in *From Warehouses to Memory*, 2026): the industry is converging on two complementary layers. An **exact layer** — lossless, auditable, increasingly built from open formats on cheap storage, keeper of shared definitions, boring on purpose. An **associative layer** — lossy, reconstructive, meaning-shaped, the interface both humans and models actually touch. Questions divide accordingly: "what do we owe" belongs to the first; "what was that like" to the second; and a system that answers both must contain both, because the lossy layer can never absorb the lossless one (hallucination is a decompression artifact, and audits do not accept confabulation).

Pentagram is that settlement in miniature: the log is the exact layer, everything derived is the associative layer, and the architecture's single most load-bearing rule — mutation only above the line — is the two-layer thesis expressed as an invariant.

The analytical tail completes the picture. When aggregate questions over a large cold log matter ("memory formation by client by month"), the design compacts tombstoned and aged log segments into columnar files (Parquet), where any SQL engine can serve them. The living system stays Lisp; the archive joins the composable stack. This is the hot/cold pattern every serious HTAP system converges on, applied to memory.

## 7. Related work

**Datomic** (Hickey) is the nearest ancestor: an accumulate-only fact log, queries as data structures (Datalog in EDN — typed S-expressions), derived indexes, time travel as a free consequence. Pentagram differs in the associative layer — embeddings, reinforcement, decay have no Datomic counterpart — and in making the stored values themselves executable. **Event sourcing** supplies the log discipline; **Kimball's dimensional warehousing** supplies the consolidation pattern (§3.5) and the eventual columnar archive. **Kuzu** and **LanceDB** are the closest contemporary systems attacking the columnar+graph+vector middle from opposite ends; both are engines-with-APIs rather than languages, which is the axis on which pentagram is differentiated rather than competitive. **Hyperdimensional computing** (Kanerva) grounds the associative layer's theory; the **dequantization literature** (Tang 2018 and successors) grounds the sampling roadmap; **MemGPT-style agent-memory systems** and the broader RAG literature define the workload but build on rented stores rather than owned substrates.

## 8. Limitations

Stated as facts, not caveats:

- **The v0 embedder is not semantic.** Hashed character trigrams give deterministic, offline similarity adequate for tests; real recall quality requires a learned embedding model behind `embed()`. This is the highest-leverage single swap.
- **Recall is a full scan** — O(episodes) per query. Adequate to ~10⁵ episodes; beyond that an ANN index (HNSW) over the derived layer is required. Because the layer is disposable (§3.2), adding one is a re-derivation, not a migration.
- **The log is one text file** with synchronous appends: no concurrent writers, no segmentation, no snapshotting. The event-sourced design makes all three straightforward; none exist yet.
- **`replay` is unsandboxed.** Stored code evaluates with the store's full environment. Single-user acceptable; multi-tenant disqualifying until capabilities and resource limits exist.
- **Ecosystem gravity.** Nothing operational speaks S-expressions; every integration (BI, observability, backup tooling) is bespoke until the columnar archive (§6) provides a SQL-legible surface.
- **The multi-model trap** (§1.2) is a standing risk for exactly this kind of project. The defense is architectural discipline: one substrate, derived indexes only, and refusal to grow a second source of truth.

## 9. Evaluation plan

Falsifiable checkpoints, in order: (1) recall quality against a labeled agent-memory benchmark before and after the real-embedder swap — the claim is that scoring by `similarity × recency × strength` beats similarity-only retrieval on multi-session tasks; (2) reinforcement ablation — disable P2 and measure retrieval degradation over a simulated month of use; (3) scale ceiling — episodes-per-second and recall latency at 10⁴/10⁵/10⁶ episodes, before and after ANN; (4) consolidation fidelity — do provenance-carrying summaries answer as well as their source episodes at a fraction of the token cost; (5) agent-protocol error rate — malformed-expression frequency when production LLMs drive the store directly, versus the same models writing SQL.

## 10. Status

v0 (July 2026, ~700 lines, zero runtime dependencies) implements: the reader/printer/evaluator; the append-only log with all four event types; derived embeddings, traces, and links; scored, reinforcing recall; bounded-depth traversal; decay with tombstones; procedural memory via `replay`; a REPL; and an end-to-end test covering language, memory, graph, replay, and restart-refold persistence. Next, in order: real embeddings, the MCP adapter (pentagram as a memory substrate for any agent), `defmacro`, consolidation, log segmentation, ANN, columnar archive. Pentagram is a standalone open-source framework; it depends on no product and no product depends on it.

---

## References

- E. Tang, "A Quantum-Inspired Classical Algorithm for Recommendation Systems," arXiv:1807.04271 (2018).
- I. Kerenidis, A. Prakash, "Quantum Recommendation Systems," arXiv:1603.08675 (2016).
- P. Kanerva, "Hyperdimensional Computing," *Cognitive Computation* 1, 139–159 (2009).
- R. Kimball, M. Ross, *The Data Warehouse Toolkit*, 3rd ed., Wiley (2013).
- R. Hickey, "The Database as a Value," (Datomic design talks, 2012).
- J. McCarthy, "Recursive Functions of Symbolic Expressions and Their Computation by Machine, Part I," *CACM* 3(4) (1960).
- Y. Malkov, D. Yashunin, "Efficient and Robust Approximate Nearest Neighbor Search Using Hierarchical Navigable Small World Graphs," arXiv:1603.09320 (2016).
- M. Armbrust et al., "Lakehouse: A New Generation of Open Platforms that Unify Data Warehousing and Advanced Analytics," CIDR (2021).
- D. Abadi, S. Madden, N. Hachem, "Column-Stores vs. Row-Stores: How Different Are They Really?," SIGMOD (2008).
- *From Warehouses to Memory: How Analytical Data Systems Work, and Where They're Going* (2026) — companion volume; chapters 14, 18, 19 develop the substrate argument.
