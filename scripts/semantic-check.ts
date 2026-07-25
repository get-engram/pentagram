// Exercises the real (MiniLM) embedder: downloads the model on first run
// (~25 MB, then cached). Verifies that semantically related but lexically
// different sentences rank above lexically similar but unrelated ones —
// the case the hash embedder cannot get right.

import * as fs from "node:fs";
import { Store } from "../src/store.js";
import { semanticEmbedder, disposeEmbedder } from "../src/embed.js";

const LOG = "semantic-check.pgram";
const cleanup = () => {
  for (const f of [LOG, LOG + ".vecs.json", LOG + ".lock"]) if (fs.existsSync(f)) fs.unlinkSync(f);
};
cleanup();

const store = await Store.open(LOG, semanticEmbedder);

const target = await store.remember("the invoice from the vendor is overdue and needs payment");
await store.remember("we planted new flowers in the garden bed yesterday");
await store.remember("the payment gateway bill remains unpaid past its due date"); // paraphrase
await store.remember("an overdue library book about gardens and vendors of flowers"); // lexical trap

const results = await store.recall("which bills have not been paid yet", 3);
console.log("query: which bills have not been paid yet");
for (const r of results) {
  console.log(`  ${r.similarity.toFixed(3)}  ${r.episode.text}`);
}

const topTwo = results.slice(0, 2).map((r) => r.episode.text);
const ok =
  topTwo.some((t) => t.includes("invoice")) && topTwo.some((t) => t.includes("gateway bill"));
console.log(
  ok
    ? "\n✓ semantic embedder ranks paraphrases above lexical traps"
    : "\n✗ unexpected ranking — inspect scores above",
);
console.log(`(target episode: ${target})`);
cleanup();
await disposeEmbedder();
// No process.exit(): onnxruntime-node aborts if the process dies while its
// worker threads hold locks. Set the code and let the event loop drain.
process.exitCode = ok ? 0 : 1;
