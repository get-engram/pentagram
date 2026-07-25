// Benchmark: exact full-scan recall vs HNSW at 5,000 episodes.
// Reports latency for both paths and the overlap of their top-10 results
// (HNSW is approximate; overlap is the recall-quality number that matters).

import * as fs from "node:fs";
import { Store } from "../src/store.js";
import { hashEmbedder, cosine } from "../src/embed.js";
import { HNSW } from "../src/hnsw.js";

const N = 5_000;
const QUERIES = 20;
const K = 10;

const LOG = "bench.pgram";
const cleanup = () => {
  for (const f of [LOG, LOG + ".vecs.json", LOG + ".lock"]) if (fs.existsSync(f)) fs.unlinkSync(f);
};
cleanup();

// Synthetic-but-plausible episodes from composable vocabulary.
const topics = ["invoice", "deploy", "meeting", "warehouse", "checkout", "migration", "backup", "contract", "outage", "estimate"];
const actors = ["the client", "ahmad", "the vendor", "finance", "the team", "support"];
const verbs = ["approved", "delayed", "reviewed", "escalated", "completed", "questioned", "scheduled", "cancelled"];
const details = ["for the mobile app", "on the staging server", "worth $40k", "before the deadline", "after the incident", "for Q3", "in the morning", "with reservations"];

function text(i: number): string {
  return `${actors[i % actors.length]} ${verbs[(i >> 2) % verbs.length]} the ${topics[(i >> 4) % topics.length]} ${details[(i >> 6) % details.length]} (case ${i})`;
}

console.log(`building store with ${N} episodes (hash embedder)...`);
const store = await Store.open(LOG, hashEmbedder);
const t0 = performance.now();
for (let i = 0; i < N; i++) await store.remember(text(i));
console.log(`  ingest: ${((performance.now() - t0) / 1000).toFixed(1)}s (includes vec-cache writes)`);

// Direct comparison on the raw vectors, outside the store, so we can measure
// scan and index against identical inputs.
const ids: string[] = [];
const vecs: Float32Array[] = [];
for (let i = 0; i < N; i++) {
  const v = await hashEmbedder.embed(text(i));
  ids.push(String(i));
  vecs.push(v);
}

const tBuild = performance.now();
const index = new HNSW();
for (let i = 0; i < N; i++) index.insert(ids[i], vecs[i]);
console.log(`  hnsw build: ${((performance.now() - tBuild) / 1000).toFixed(1)}s`);

const queries = Array.from({ length: QUERIES }, (_, q) =>
  `${topics[q % topics.length]} ${verbs[q % verbs.length]} ${actors[q % actors.length]}`);

let scanMs = 0;
let annMs = 0;
let overlap = 0;

for (const q of queries) {
  const qv = await hashEmbedder.embed(q);

  const s0 = performance.now();
  const exact = vecs
    .map((v, i) => ({ id: ids[i], sim: cosine(qv, v) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, K);
  scanMs += performance.now() - s0;

  const a0 = performance.now();
  const approx = index.search(qv, K);
  annMs += performance.now() - a0;

  const exactSet = new Set(exact.map((r) => r.id));
  overlap += approx.filter((r) => exactSet.has(r.id)).length / K;
}

console.log(`\nper-query latency over ${QUERIES} queries, N=${N}, top-${K}:`);
console.log(`  exact scan: ${(scanMs / QUERIES).toFixed(2)} ms`);
console.log(`  hnsw:       ${(annMs / QUERIES).toFixed(2)} ms  (${(scanMs / annMs).toFixed(1)}x faster)`);
console.log(`  top-${K} overlap with exact: ${((overlap / QUERIES) * 100).toFixed(0)}%`);

await store.recall("warehouse estimate", 3); // index builds lazily on first recall
const stats = store.stats();
console.log(`\nstore recall_index at N=${N} after first recall: ${stats.recall_index} (threshold 2000)`);

cleanup();
