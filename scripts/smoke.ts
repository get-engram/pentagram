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
import { extractiveSummarizer } from "../src/summarize.js";
import { Tenants } from "../src/tenants.js";

const LOG = "smoke-memory.pgram";
const cleanup = () => {
  for (const f of [LOG, LOG + ".vecs.json", LOG + ".lock"]) if (fs.existsSync(f)) fs.unlinkSync(f);
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

console.log("\n— replay is sandboxed —");
const evil = await run(`(remember '(remember "injected"))`);
let sandboxed = false;
try {
  await run(`(replay "${evil}")`);
} catch (e: any) {
  sandboxed = /unbound symbol: remember/.test(e.message);
}
assert(sandboxed, "(replay id) cannot reach memory ops (language-only env)");
const escalated = await run(`(replay! "${evil}")`);
assert(typeof escalated === "string", "(replay! id) deliberately escalates to full access");

console.log("\n— entity layer —");
const e1 = await run(`(entity "acme corp" 'client)`);
const e1again = await run(`(entity "acme corp" 'client)`);
assert(e1 === e1again, "entities dedupe by name+kind (one graph node per entity)");
await run(`(mention "${a}" "${e1}")`);
const entHops: any = await run(`(hops "${e1}" 1)`);
assert(
  entHops.some((h: any) => h[0] === a),
  "one hop from the entity reaches the episode that mentions it",
);
const entRecall: any = await run(`(recall "acme" 1)`);
assert(entRecall[0][0] === e1, "entities are recallable like any memory");

console.log("\n— importance: connected memories rank higher —");
const i1 = await run(`(remember "the quarterly report template lives in the shared drive")`);
const i2 = await run(`(remember "the quarterly report template lives in the shared drive")`);
await run(`(link "${i2}" 'about "${e1}")`);
const impRecall: any = await run(`(recall "where is the quarterly report template" 2)`);
assert(
  impRecall[0][0] === i2,
  "of two identical memories, the linked one outranks (degree importance)",
);

console.log("\n— consolidation: sleep as ETL —");
// Three near-duplicate old episodes about the same client issue.
const oldTs = Date.now() - 30 * 24 * 3_600_000;
const s1 = await store.remember("client reported the checkout page is slow on mobile", oldTs);
const s2 = await store.remember("client says mobile checkout page loads slowly again", oldTs);
const s3 = await store.remember("mobile checkout slowness reported by the client once more", oldTs);
const facts = await store.consolidate({
  minAgeHours: 24,
  threshold: 0.3,
  summarizer: async (texts) =>
    `STUB: client repeatedly reported slow mobile checkout (${texts.length} episodes)`,
});
assert(
  store.get(facts[0])!.text.startsWith("STUB:") && store.get(facts[0])!.text.includes("(3 episodes)"),
  "consolidation uses the pluggable summarizer",
);
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

console.log("\n— external provenance: claims with pointers —");
const pf = await run(
  `(fact! "acme's outstanding balance was disputed in march" ` +
  `'((postgres "invoices/1234" 1755212000000) (episode "${a}")))`,
);
const srcs: any = await run(`(sources "${pf}")`);
assert(srcs.length === 2, "structured provenance entries returned by (sources)");
assert(print(srcs).includes("postgres") && print(srcs).includes("invoices/1234"),
  "external reference round-trips through the log");
const provRaw: any = await run(`(provenance "${pf}")`);
assert(provRaw.length === 2, "(provenance) returns the full raw evidence list");
const factRecall: any = await run(`(recall "dispute about the acme balance" 3)`);
assert(factRecall.some((r: any) => r[0] === pf), "asserted fact is recallable");

console.log("\n— revise: reconsolidation with a paper trail —");
const rv = await run(
  `(revise! "${pf}" "acme's dispute was resolved and paid on aug 12" ` +
  `'((postgres "invoices/1234" 1755300000000)))`,
);
const afterRevise: any = await run(`(recall "acme balance dispute" 5)`);
assert(afterRevise.some((r: any) => r[0] === rv), "successor fact surfaces in recall");
assert(!afterRevise.some((r: any) => r[0] === pf), "superseded fact hidden from recall");
assert(store.get(pf)!.forgotten && store.get(pf)!.text.includes("disputed in march"),
  "superseded fact tombstoned but still in the store (log keeps everything)");
const chain: any = await run(`(history "${rv}")`);
assert(chain.length === 2 && chain[0][0] === rv && chain[1][0] === pf,
  "(history) walks the supersedes chain newest-first");

console.log("\n— entity extraction (stub extractor) —");
const ex1 = await store.remember("met with sarah from globex about the migration project");
const stubExtractor = async (text: string) => {
  const found = [];
  if (text.includes("sarah")) found.push({ name: "sarah", kind: "person" });
  if (text.includes("globex")) found.push({ name: "globex", kind: "org" });
  return found;
};
const extRes = await store.extractEntities({ extractor: stubExtractor, limit: 100 });
assert(extRes.has(ex1), "unprocessed episode was extracted");
assert(extRes.get(ex1)!.length === 2, "two entities mined from the episode");
const sarahHops = store.hops(extRes.get(ex1)![0], 1);
assert(sarahHops.some((h) => h.id === ex1), "mined entity links back to its episode");
const extAgain = await store.extractEntities({ extractor: stubExtractor, limit: 100 });
assert(!extAgain.has(ex1), "extraction is incremental (extracted marker persists)");

console.log("\n— single-writer lock —");
let lockRefused = false;
try {
  await Store.open(LOG, hashEmbedder);
} catch (e: any) {
  lockRefused = /locked by running process/.test(e.message);
}
assert(lockRefused, "second open of a locked log is refused");
fs.writeFileSync(LOG + ".lock", "999999999"); // simulate a dead holder
// (current store keeps its handle; stale-steal is exercised on reopen below)

console.log("\n— sleep cycle —");
const SLEEPLOG = "smoke-sleep.pgram";
for (const f of [SLEEPLOG, SLEEPLOG + ".vecs.json", SLEEPLOG + ".lock"]) if (fs.existsSync(f)) fs.unlinkSync(f);
const sleepStore = await Store.open(SLEEPLOG, hashEmbedder, async (texts) => `sleep-fact: ${texts.length} episodes`, {
  extractor: stubExtractor,
});
await sleepStore.remember("sarah confirmed the globex meeting");
const cycle = await sleepStore.sleepCycle();
console.log(`  cycle → ${JSON.stringify(cycle)}`);
assert(typeof cycle.forgotten === "number" && typeof cycle.facts === "number", "sleep cycle runs decay → extract → consolidate");
assert(cycle.extracted === 1, "sleep cycle extracted the new episode");
sleepStore.close();
for (const f of [SLEEPLOG, SLEEPLOG + ".vecs.json"]) if (fs.existsSync(f)) fs.unlinkSync(f);

console.log("\n— log segmentation: rollover + snapshot —");
const SEGLOG = "smoke-segment.pgram";
const segCleanup = () => {
  for (const f of fs.readdirSync(".").filter((f) => f.startsWith(SEGLOG))) fs.unlinkSync(f);
};
segCleanup();
let seg = await Store.open(SEGLOG, hashEmbedder);
const keepId = await seg.remember("the retained memory about database design");
const segClose = () => seg.close();
for (let i = 0; i < 50; i++) await seg.remember(`filler memory number ${i} about nothing in particular`);
const compId = await seg.remember("linked companion memory");
seg.link(keepId, "about", compId);
// Recall traffic: 10×5 recalled events in the log, which the snapshot
// compacts into a handful of trace lines — that's the size win.
for (let i = 0; i < 10; i++) await seg.recall("filler memory", 5);
const preStats = seg.stats();
// Reopen with a tiny rollover threshold to force segmentation.
segClose();
seg = await Store.open(SEGLOG, hashEmbedder, extractiveSummarizer, { maxLogBytes: 1024 });
const archives = fs.readdirSync(".").filter((f) => f.startsWith(SEGLOG) && f.endsWith(".archive"));
assert(archives.length === 1, "oversized log archived intact");
assert(fs.statSync(SEGLOG).size < fs.statSync(archives[0]).size, "active snapshot is smaller than the archived history");
assert(seg.stats().episodes === preStats.episodes, "all live episodes survive rollover");
const segRecall = await seg.recall("database design", 1);
assert(segRecall[0].id === keepId, "recall works from the snapshot");
seg.close();
seg = await Store.open(SEGLOG, hashEmbedder); // reopen once more: snapshot refolds cleanly
assert(seg.get(keepId) !== undefined, "snapshot survives a further restart");

console.log("\n— archive compaction to parquet —");
let pqAvailable = true;
try {
  await import("@dsnp/parquetjs");
} catch {
  pqAvailable = false;
}
if (pqAvailable) {
  const parquets = await seg.compactArchives();
  assert(parquets.length === 1, "archive compacted to one parquet file");
  assert(!fs.existsSync(archives[0]), "original text archive removed after lossless conversion");
  const pq: any = await import("@dsnp/parquetjs");
  const reader = await pq.ParquetReader.openFile(parquets[0]);
  const cursor = reader.getCursor();
  let rows = 0;
  let episodeRows = 0;
  let rawOk = true;
  for (let row = await cursor.next(); row; row = await cursor.next()) {
    rows++;
    if (row.event === "episode") episodeRows++;
    if (!String(row.raw).startsWith("(")) rawOk = false;
  }
  await reader.close();
  assert(episodeRows >= 52, `parquet holds the archived episodes (${episodeRows} rows)`);
  assert(rawOk && rows > episodeRows, `raw S-expression column preserved on all ${rows} rows`);
} else {
  console.log("  (skipped: optional @dsnp/parquetjs not installed)");
}
seg.close();
segCleanup();

console.log("\n— multi-tenant isolation —");
const TROOT = "smoke-tenants";
fs.rmSync(TROOT, { recursive: true, force: true });
const tenants = new Tenants(TROOT, hashEmbedder);
const alpha = await tenants.get("alpha");
const beta = await tenants.get("beta");
await alpha.remember("alpha secret: the launch code is waffles");
await beta.remember("beta note: a completely unrelated grocery list");
const alphaRecall = await alpha.recall("secret launch code", 3);
const betaRecall = await beta.recall("secret launch code", 3);
assert(alphaRecall.some((r) => r.episode.text.includes("waffles")), "tenant alpha recalls its own memory");
assert(!betaRecall.some((r) => r.episode.text.includes("waffles")), "tenant beta cannot see alpha's memory");
assert((await tenants.get("alpha")) === alpha, "tenant stores are cached per name");
let rejected = false;
try {
  await tenants.get("../evil");
} catch (e: any) {
  rejected = /invalid tenant name/.test(e.message);
}
assert(rejected, "path-traversal tenant name rejected");
await tenants.close();
fs.rmSync(TROOT, { recursive: true, force: true });

console.log("\n— persistence: restart and refold the log —");
// Capture immediately before restart: recalls in later sections may have
// reinforced this trace again since the observation-is-a-write test ran.
const preRestartCount = store.trace(a as string)!.recallCount;
// The lockfile currently holds a fake dead pid (planted above): this reopen
// must steal the stale lock instead of refusing.
store = await Store.open(LOG, hashEmbedder);
assert(fs.readFileSync(LOG + ".lock", "utf8") === String(process.pid), "stale lock stolen on reopen");
env = memoryEnv(store);
const recall2: any = await run(`(recall "star schema dimensions" 1)`);
assert(recall2[0][0] === b, "state survives restart (log refold)");
assert(store.trace(a as string)!.recallCount === preRestartCount, "reinforcement events survive restart");
assert(store.get(facts[0])!.kind === "fact", "facts survive restart");
assert(print(store.sources(rv as string)).includes("invoices/1234"),
  "external provenance survives restart");
const chainAfter = store.history(rv as string);
assert(chainAfter.length === 2 && chainAfter[1].forgotten,
  "supersedes chain survives restart, predecessor still tombstoned");
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
