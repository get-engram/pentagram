// Evaluation harness — executes the design paper's evaluation plan, item (1)
// and (2): does composite recall scoring (similarity × recency × strength ×
// importance) beat similarity-only retrieval on a simulated month of agent
// usage? Deterministic (seeded), offline (hash embedder by default; set
// EVAL_EMBEDDER=semantic to run MiniLM).
//
// World model: topics with paraphrased memories plus lexically-close
// "confuser" distractors. Hot topics are recalled repeatedly through the
// month (reinforcement + recency); stale topics and confusers are not.
// Final probes measure whether the store surfaces the memory the agent
// actually uses over the lookalike it doesn't.
//
// Conditions:
//   sim        — cosine similarity only (what a bare vector store gives you)
//   sim×rec    — similarity × recency (no usage signal)
//   full       — the store's actual composite scoring
//
// Metrics: P@1 and MRR over all probes.

import * as fs from "node:fs";
import { Store } from "../src/store.js";
import { hashEmbedder, semanticEmbedder, cosine, Embedder } from "../src/embed.js";

const embedder: Embedder =
  process.env.EVAL_EMBEDDER === "semantic" ? semanticEmbedder : hashEmbedder;

const LOG = "eval-tmp.pgram";
const cleanup = () => {
  for (const f of [LOG, LOG + ".vecs.json", LOG + ".lock"]) if (fs.existsSync(f)) fs.unlinkSync(f);
};
cleanup();

// ---------- the simulated world ----------

interface Topic {
  key: string;
  kind: "hot" | "warm" | "stale";
  memories: string[]; // paraphrases; [0] is the canonical target
  confuser: string; // lexically close, semantically wrong, never used
  probe: string;
}

const TOPICS: Topic[] = [
  {
    key: "invoice-dispute", kind: "hot",
    memories: [
      "the acme invoice dispute was escalated to finance in march",
      "finance is handling the escalated acme billing dispute from march",
    ],
    confuser: "the acme invoice dispute checklist explains what happens in march",
    probe: "what happened with the acme invoice dispute in march",
  },
  {
    key: "deploy-freeze", kind: "hot",
    memories: [
      "the production deploy freeze starts friday before the holiday weekend",
      "no production deploys after friday due to the holiday freeze",
    ],
    confuser: "the production deploy freeze calendar shows when each freeze starts",
    probe: "when does the production deploy freeze start",
  },
  {
    key: "vendor-contract", kind: "hot",
    memories: [
      "the shipping vendor contract renews in september at the old rate",
      "september renewal of the shipping vendor contract keeps current pricing",
    ],
    confuser: "the shipping vendor contract renewal steps explain when to renew",
    probe: "when does the shipping vendor contract renew",
  },
  {
    key: "onboarding-doc", kind: "warm",
    memories: [
      "the engineering onboarding document moved to the shared wiki",
      "new engineers should use the onboarding document on the wiki",
    ],
    confuser: "the engineering offboarding document was archived from the wiki",
    probe: "where is the engineering onboarding document",
  },
  {
    key: "budget-approval", kind: "warm",
    memories: [
      "the q4 marketing budget was approved at two hundred thousand",
      "marketing gets two hundred thousand for the approved q4 budget",
    ],
    confuser: "the q4 marketing budget process requires two approval steps",
    probe: "what is the approved q4 marketing budget",
  },
  {
    key: "server-migration", kind: "stale",
    memories: [
      "the database server migration to the new region finished in january",
      "january completed the database migration to the new region",
    ],
    confuser: "the database server migration checklist template has twelve steps",
    probe: "when did the database server migration finish",
  },
  {
    key: "support-rotation", kind: "stale",
    memories: [
      "the support rotation schedule pairs one senior with one junior engineer",
      "each support rotation pairs a senior engineer with a junior",
    ],
    confuser: "the support rotation schedule tool sends one reminder per engineer",
    probe: "how does the support rotation pairing work",
  },
];

const NOISE = [
  "the office plants were watered on tuesday as usual",
  "lunch orders go through the new catering portal now",
  "the parking garage code changed to the same as the door code",
  "team photos from the offsite are in the shared drive",
  "the printer on the third floor is out of toner again",
  "standup moved thirty minutes earlier on wednesdays",
];

// ---------- run the month ----------

const DAY = 24 * 3_600_000;
const T0 = 1_755_000_000_000; // month start
const NOW = T0 + 30 * DAY; // probe time

const store = await Store.open(LOG, embedder);
const mirror: { id: string; text: string; ts: number }[] = [];
const rememberAt = async (text: string, ts: number) => {
  const id = await store.remember(text, ts);
  mirror.push({ id, text, ts });
  return id;
};

const targets = new Map<string, string>(); // topic key -> canonical memory id

for (const t of TOPICS) {
  const born = t.kind === "warm" ? T0 + 15 * DAY : T0 + 2 * DAY;
  targets.set(t.key, await rememberAt(t.memories[0], born));
  await rememberAt(t.memories[1], born + DAY);
  await rememberAt(t.confuser, born + DAY / 2);
}
for (let i = 0; i < NOISE.length; i++) await rememberAt(NOISE[i], T0 + (i + 1) * 3 * DAY);

// Hot topics get used through the month. Two signals, mirroring real agent
// behavior: recall reinforces whatever surfaced (traps included), and the
// agent then touches the memory it ACTUALLY used — the feedback signal that
// separates the true answer from the lexical lookalike.
for (const t of TOPICS.filter((t) => t.kind === "hot")) {
  for (let week = 1; week <= 4; week++) {
    const when = T0 + week * 7 * DAY;
    await store.recall(t.probe, 2, when);
    store.touch(targets.get(t.key)!, when);
  }
}

// ---------- probe under each condition ----------

const vecs = new Map<string, Float32Array>();
for (const m of mirror) vecs.set(m.id, await embedder.embed(m.text));

function rank(scored: { id: string; score: number }[], targetId: string): number {
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  return sorted.findIndex((s) => s.id === targetId) + 1; // 1-based; 0 if absent
}

interface Cond { name: string; probe: (t: Topic) => Promise<number> }

const conditions: Cond[] = [
  {
    name: "sim only",
    probe: async (t) => {
      const q = await embedder.embed(t.probe);
      return rank(mirror.map((m) => ({ id: m.id, score: cosine(q, vecs.get(m.id)!) })), targets.get(t.key)!);
    },
  },
  {
    name: "sim × recency",
    probe: async (t) => {
      const q = await embedder.embed(t.probe);
      return rank(
        mirror.map((m) => ({
          id: m.id,
          score: cosine(q, vecs.get(m.id)!) * Math.pow(0.5, (NOW - m.ts) / 3_600_000 / (24 * 30)),
        })),
        targets.get(t.key)!,
      );
    },
  },
  {
    name: "full (store)",
    probe: async (t) => {
      const results = await store.recall(t.probe, mirror.length, NOW);
      const idx = results.findIndex((r) => r.id === targets.get(t.key)!);
      return idx + 1;
    },
  },
];

console.log(`pentagram eval — embedder: ${embedder.name}, ${mirror.length} memories, ${TOPICS.length} probes\n`);
console.log("condition      | P@1  | MRR  | per-topic ranks (hot | warm | stale)");
console.log("---------------|------|------|--------------------------------------");

for (const cond of conditions) {
  const ranks: { kind: string; r: number }[] = [];
  for (const t of TOPICS) {
    ranks.push({ kind: t.kind, r: await cond.probe(t) });
  }
  const p1 = ranks.filter((x) => x.r === 1).length / ranks.length;
  const mrr = ranks.reduce((a, x) => a + (x.r > 0 ? 1 / x.r : 0), 0) / ranks.length;
  const show = (kind: string) => ranks.filter((x) => x.kind === kind).map((x) => x.r).join(",");
  console.log(
    `${cond.name.padEnd(14)} | ${p1.toFixed(2)} | ${mrr.toFixed(2)} | ${show("hot")} | ${show("warm")} | ${show("stale")}`,
  );
}

console.log(
  "\nreading: rank of the canonical (actually-used) memory for each probe; 1 is best." +
  "\nhot topics were recalled weekly (reinforced); confusers are lexical traps that were never used.",
);
store.close();
cleanup();
