// End-to-end smoke test: language (incl. macros/quasiquote), memory, graph,
// procedural replay, observation-as-write, consolidation, and persistence
// across a restart. Runs on the hash embedder so it is deterministic and
// offline; scripts/semantic-check.ts exercises the real embedder.

import * as fs from "node:fs";
import { Store } from "../src/store.js";
import { memoryEnv } from "../src/memory.js";
import { evaluate } from "../src/eval.js";
import { read, print } from "../src/sexp.js";
import { hashEmbedder } from "../src/embed.js";

const LOG = "smoke-memory.pgram";
const cleanup = () => {
  for (const f of [LOG, LOG + ".vecs.json"]) if (fs.existsSync(f)) fs.unlinkSync(f);
};
cleanup();

let store = await Store.open(LOG, hashEmbedder);
let env = memoryEnv(store);
const run = (src: string) => evaluate(read(src), env);
const show = async (src: string) => console.log(`⛧ ${src}\n  → ${print(await run(src))}`);

let failures = 0;
const assert = (cond: boolean, msg: string) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ FAIL: ${msg}`);
    failures++;
  }
};

console.log("— language core —");
await show("(+ 1 2 3)");
await show("(define (double x) (* x 2))");
assert(print(await run("(map double (list 1 2 3))")) === "(2 4 6)", "closures and map work");

console.log("\n— macros and quasiquote —");
await run("(defmacro unless (c body) `(if ,c () ,body))");
assert((await run("(unless false 42)")) === 42, "(unless false 42) → 42 via macro expansion");
assert(print(await run("(unless true 42)")) === "()", "(unless true 42) → ()");
assert(
  print(await run("`(1 ,(+ 1 1) ,@(list 3 4))")) === "(1 2 3 4)",
  "quasiquote with unquote and splicing",
);

console.log("\n— episodic memory —");
const a = await run(`(remember "warehouse costs are dominated by idle compute credits")`);
const b = await run(`(remember "star schemas put facts in the center and dimensions around them")`);
const c = await run(`(remember "duckdb reads parquet directly from object storage")`);
await run(`(remember "the client meeting moved to thursday afternoon")`);

const recall1: any = await run(`(recall "why are warehouses expensive" 2)`);
console.log(`  recall → ${print(recall1)}`);
assert(recall1[0][0] === a, "recall ranks the warehouse-cost memory first");

console.log("\n— observation is a write —");
const before = store.trace(a as string)!.recallCount;
await run(`(recall "warehouse cost" 1)`);
const after = store.trace(a as string)!.recallCount;
assert(after > before, `recall reinforced the trace (count ${before} → ${after})`);

console.log("\n— graph layer —");
await run(`(link "${a}" 'about "${c}")`);
await run(`(link "${c}" 'about "${b}")`);
const hops: any = await run(`(hops "${a}" 2)`);
assert(hops.length === 2, "two-hop traversal reaches both linked memories");

console.log("\n— procedural memory (code as data) —");
const p = await run(`(remember '(lambda (n) (* n n)))`);
const sq: any = await run(`((replay "${p}") 9)`);
assert(sq === 81, "replay evaluates stored code: (f 9) → 81");

console.log("\n— consolidation: sleep as ETL —");
// Three near-duplicate old episodes about the same client issue.
const oldTs = Date.now() - 30 * 24 * 3_600_000;
const s1 = await store.remember("client reported the checkout page is slow on mobile", oldTs);
const s2 = await store.remember("client says mobile checkout page loads slowly again", oldTs);
const s3 = await store.remember("mobile checkout slowness reported by the client once more", oldTs);
const facts = await store.consolidate({ minAgeHours: 24, threshold: 0.3 });
console.log(`  facts created: ${print(facts)}`);
assert(facts.length >= 1, "similar old episodes consolidated into a fact");
const fact = store.get(facts[0])!;
assert(fact.kind === "fact", "consolidated memory is a fact");
assert(
  [s1, s2, s3].every((id) => fact.provenance!.includes(id)),
  "fact carries provenance to all source episodes",
);
assert(
  [s1, s2, s3].every((id) => store.get(id)!.forgotten),
  "source episodes tombstoned (but still in the log)",
);
const recallFact: any = await run(`(recall "mobile checkout performance" 1)`);
assert(recallFact[0][0] === facts[0], "recall now surfaces the consolidated fact");
const prov: any = await run(`(provenance "${facts[0]}")`);
assert(prov.length === 3, "(provenance fact-id) resolves from the language");

console.log("\n— persistence: restart and refold the log —");
store = await Store.open(LOG, hashEmbedder);
env = memoryEnv(store);
const recall2: any = await run(`(recall "star schema dimensions" 1)`);
assert(recall2[0][0] === b, "state survives restart (log refold)");
assert(store.trace(a as string)!.recallCount === after, "reinforcement events survive restart");
assert(store.get(facts[0])!.kind === "fact", "facts survive restart");
assert(fs.existsSync(LOG + ".vecs.json"), "vector cache sidecar written");
await show("(stats)");

console.log("\n— the log itself is s-expressions —");
console.log(
  fs.readFileSync(LOG, "utf8").split("\n").slice(0, 3).map((l) => "  " + l).join("\n"),
);

cleanup();
if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall assertions passed ⛧");
