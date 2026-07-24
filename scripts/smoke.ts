// End-to-end smoke test: language, memory, graph, procedural replay,
// observation-as-write, and persistence across a restart.

import * as fs from "node:fs";
import { Store } from "../src/store.js";
import { memoryEnv } from "../src/memory.js";
import { evaluate } from "../src/eval.js";
import { read, print } from "../src/sexp.js";

const LOG = "smoke-memory.pgram";
if (fs.existsSync(LOG)) fs.unlinkSync(LOG);

let store = new Store(LOG);
let env = memoryEnv(store);
const run = (src: string) => evaluate(read(src), env);
const show = (src: string) => console.log(`⛧ ${src}\n  → ${print(run(src))}`);

let failures = 0;
const assert = (cond: boolean, msg: string) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ FAIL: ${msg}`);
    failures++;
  }
};

console.log("— language core —");
show("(+ 1 2 3)");
show("(define (double x) (* x 2))");
show("(map double (list 1 2 3))");
assert(print(run("(map double (list 1 2 3))")) === "(2 4 6)", "closures and map work");

console.log("\n— episodic memory —");
const a = run(`(remember "warehouse costs are dominated by idle compute credits")`);
const b = run(`(remember "star schemas put facts in the center and dimensions around them")`);
const c = run(`(remember "duckdb reads parquet directly from object storage")`);
const d = run(`(remember "the client meeting moved to thursday afternoon")`);
console.log(`  stored episodes: ${a} ${b} ${c} ${d}`);

const recall1: any = run(`(recall "why are warehouses expensive" 2)`);
console.log(`  recall → ${print(recall1)}`);
assert(recall1[0][0] === a, "semantic recall ranks the warehouse-cost memory first");

console.log("\n— observation is a write —");
const before = store.trace(a as string)!.recallCount;
run(`(recall "warehouse cost" 1)`);
const after = store.trace(a as string)!.recallCount;
assert(after > before, `recall reinforced the trace (count ${before} → ${after})`);

console.log("\n— graph layer —");
run(`(link "${a}" 'about "${c}")`);
run(`(link "${c}" 'about "${b}")`);
const hops: any = run(`(hops "${a}" 2)`);
console.log(`  hops → ${print(hops)}`);
assert(hops.length === 2, "two-hop traversal reaches both linked memories");

console.log("\n— procedural memory (code as data) —");
const p = run(`(remember '(lambda (n) (* n n)))`);
const sq: any = run(`((replay "${p}") 9)`);
console.log(`  stored a lambda as a memory, replayed it: (f 9) → ${sq}`);
assert(sq === 81, "replay evaluates stored code");

console.log("\n— persistence: restart and refold the log —");
store = new Store(LOG);
env = memoryEnv(store);
const recall2: any = run(`(recall "star schema dimensions" 1)`);
assert(recall2[0][0] === b, "state survives restart (log refold)");
assert(store.trace(a as string)!.recallCount === after, "reinforcement events survive restart");
show("(stats)");

console.log("\n— the log itself is s-expressions —");
console.log(
  fs.readFileSync(LOG, "utf8").split("\n").slice(0, 4).map((l) => "  " + l).join("\n")
);

fs.unlinkSync(LOG);
if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall assertions passed ⛧");
