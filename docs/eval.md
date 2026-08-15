# Recall evaluation

Executes the design paper's evaluation plan, items (1)–(2): does composite
scoring beat similarity-only retrieval on simulated agent usage? Run it:
`npm run eval` (offline, deterministic, hash embedder) or
`EVAL_EMBEDDER=semantic npm run eval` (MiniLM, downloads once).

## Method

A deterministic simulated month: 7 topics × (2 paraphrases + 1 **confuser** —
a lexically close, semantically wrong trap that the agent never uses) + 6
noise memories = 27 memories. **Hot** topics are used weekly: the agent
recalls (which reinforces whatever surfaced, traps included) and then
**touches** the memory it actually used. **Warm** topics are stored mid-month,
never used. **Stale** topics are stored early, never used. Final probes
measure the rank of the canonical (actually-used) memory under three scoring
conditions. Metrics: P@1 and MRR over all probes.

## Results

MiniLM (semantic), the production configuration:

| condition | P@1 | MRR | hot | warm | stale |
|---|---|---|---|---|---|
| similarity only | 0.57 | 0.79 | 1,1,2 | 2,1 | 1,2 |
| similarity × recency | 0.29 | 0.64 | 2,1,2 | 2,2 | 1,2 |
| **full composite** | **0.71** | **0.86** | **1,1,1** | 2,1 | 1,2 |

Hash embedder (offline CI variant): full 0.43/0.71 vs sim-only 0.29/0.64 —
same ordering, noisier similarities.

The composite **wins on used topics and never loses elsewhere**: it flips the
vendor-contract trap that pure similarity falls for, and matches similarity
on topics with no usage signal. Note that recency *alone* is actively harmful
(0.29) — freshness without a usage signal promotes the wrong things.

## What the harness caught (design changes it forced)

1. **The original formula lost to a bare vector store.** Linear
   `sim × recency × strength` scored P@1 0.29 vs similarity's 0.71: unbounded
   multiplicative boosts let much-used memories hijack probes about
   *unrelated* quiet topics. Fix: similarity enters **squared** (relevance
   dominates; boosts break near-ties) and strength is **log-damped**
   (`1 + 0.5·ln(1+count)` — 10 recalls ≈ 2.2×, 100 ≈ 3.3×).
2. **Reinforcement followed surfacing, not use.** Recall reinforces whatever
   it returns — lexical traps included — so usage could never separate the
   true answer from its lookalike. Fix: the **`touch` API** (`(touch! id)`,
   `Store.touch`): the agent's explicit "this one mattered," logged as a
   `touched` event worth 3 passive recalls.

## Caveats, honestly

- 27 memories, 7 probes, synthetic phrasing: this is a **calibration
  harness**, not a benchmark victory. The constants were tuned on it and may
  be overfit to it; treat the *ordering* of conditions as the finding, not
  the absolute numbers.
- The hash embedder sees only lexical surface — exactly what traps exploit —
  so it understates the composite's headroom; MiniLM numbers are the
  representative ones.
- Next step on the paper's plan: an external benchmark (LoCoMo-style
  multi-session memory) against Mem0/Zep/Letta for comparable numbers.
