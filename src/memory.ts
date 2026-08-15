// Wires the memory substrate into the language. Memory operations are just
// Lisp functions; a stored memory can itself be code, and (replay id) runs it
// with the same evaluator that runs the REPL — procedural memory, literally.

import { Env, coreEnv, evaluate } from "./eval.js";
import { Store } from "./store.js";
import { Sexp, print } from "./sexp.js";

export function memoryEnv(store: Store): Env {
  const env = coreEnv();
  const def = (name: string, fn: (...args: Sexp[]) => Sexp | Promise<Sexp>) =>
    env.define(name, fn);

  // (remember "took the 27agency call, decided on vercel") -> id
  // (remember '(lambda () (* 6 7)))                        -> id  (stores code)
  def("remember", (content) => store.remember(content));

  // (recall "what did we decide about hosting" 3)
  // -> ((id score "content") ...) ; recalling reinforces.
  def("recall", async (query, n) =>
    (await store.recall(String(query), typeof n === "number" ? n : 5))
      .map((r) => [r.id, round(r.score), r.episode.text]));

  // (link id1 'about id2)
  def("link", (src, rel, dst) => {
    store.link(String(src), print(rel).replace(/"/g, ""), String(dst));
    return [];
  });

  // (hops id 2) -> ((id (rel rel)) ...)
  def("hops", (id, depth) =>
    store
      .hops(String(id), typeof depth === "number" ? depth : 2)
      .map((h) => [h.id, h.via]));

  // (content id) -> the stored expression, unevaluated
  def("content", (id) => {
    const ep = store.get(String(id));
    if (!ep) throw new Error(`no episode ${id}`);
    return ep.content;
  });

  // (provenance id) -> a fact's full evidence list: episode ids and/or
  // external references, returned as the raw S-expression it was stored as
  def("provenance", (id) => {
    const ep = store.get(String(id));
    if (!ep) throw new Error(`no episode ${id}`);
    return ep.provenance ?? [];
  });

  // (fact! "acme's balance was disputed in march"
  //        '((postgres "invoices/1234" 1755212000000)))
  // -> id. A claim WITH POINTERS: the exact value stays in the source system;
  // recall surfaces the claim, (sources id) gives the address to dereference.
  def("fact!", (text, refs) => {
    if (typeof text !== "string") throw new Error("(fact! text refs): text must be a string");
    if (refs !== undefined && !Array.isArray(refs)) throw new Error("(fact! text refs): refs must be a list");
    return store.assertFact(text, refs ?? []);
  });

  // (revise! id "acme's dispute was resolved aug 12" '(refs...)) -> new id.
  // Supersedes the old belief: hidden from recall, kept in the log forever.
  def("revise!", (id, text, refs) => {
    if (typeof text !== "string") throw new Error("(revise! id text refs): text must be a string");
    if (refs !== undefined && !Array.isArray(refs)) throw new Error("(revise! id text refs): refs must be a list");
    return store.revise(String(id), text, refs ?? []);
  });

  // (sources id) -> only the external references in a memory's provenance
  def("sources", (id) => store.sources(String(id)));

  // (history id) -> the belief chain, newest first, with each belief's
  // status: ((id ts "text" superseded?) ...)
  def("history", (id) => store.history(String(id)).map((e) => [e.id, e.ts, e.text, e.forgotten]));

  // (entity "acme corp" 'client) -> id. Deduplicated by name+kind: every
  // mention of the same entity converges on one graph node.
  def("entity", (name, kind) =>
    store.entity(String(name), kind ? print(kind).replace(/"/g, "") : "thing"));

  // (mention episode-id entity-id) — sugar for a 'mentions link.
  def("mention", (epId, entId) => {
    store.link(String(epId), "mentions", String(entId));
    return [];
  });

  // (replay id) -> evaluate the stored expression, SANDBOXED: language only,
  // no memory operations. Stored code cannot remember/link/decay/consolidate.
  def("replay", (id) => {
    const ep = store.get(String(id));
    if (!ep) throw new Error(`no episode ${id}`);
    return evaluate(ep.content, coreEnv());
  });

  // (replay! id) -> evaluate with full memory access. Trusted code only:
  // this is deliberate escalation, visible in the source as the ! warns.
  def("replay!", (id) => {
    const ep = store.get(String(id));
    if (!ep) throw new Error(`no episode ${id}`);
    return evaluate(ep.content, env);
  });

  // (decay!) -> ids tombstoned this pass
  def("decay!", () => store.decay());

  // (consolidate!) -> ids of facts created (sleep as ETL). Uses the store's
  // default summarizer; pass one via Store.consolidate() from the host for
  // LLM-backed compression (claudeSummarizer).
  def("consolidate!", () => store.consolidate());

  // (extract!) -> ((episode-id (entity-ids...)) ...) — mine entities from
  // unprocessed episodes (requires a configured extractor).
  def("extract!", async () =>
    [...(await store.extractEntities()).entries()].map(([id, ents]) => [id, ents]));

  // (sleep!) -> one full sleep cycle: decay → extract → consolidate.
  def("sleep!", async () => {
    const s = await store.sleepCycle();
    return Object.entries(s).map(([k, v]) => [k, v]);
  });

  // (compact!) -> archived log segments converted to Parquet (paths returned).
  // Requires the optional @dsnp/parquetjs dependency.
  def("compact!", () => store.compactArchives());

  // (stats) -> ((episodes n) (facts n) (entities n) (live n) (forgotten n) (links n) (embedder name))
  def("stats", () => {
    const s = store.stats();
    return Object.entries(s).map(([k, v]) => [k, v]);
  });

  return env;
}

function round(x: number): number {
  return Math.round(x * 10000) / 10000;
}
