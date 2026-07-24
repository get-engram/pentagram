// Wires the memory substrate into the language. Memory operations are just
// Lisp functions; a stored memory can itself be code, and (replay id) runs it
// with the same evaluator that runs the REPL — procedural memory, literally.

import { Env, coreEnv, evaluate } from "./eval.js";
import { Store } from "./store.js";
import { Sexp, print } from "./sexp.js";

export function memoryEnv(store: Store): Env {
  const env = coreEnv();
  const def = (name: string, fn: (...args: Sexp[]) => Sexp) => env.define(name, fn);

  // (remember "took the 27agency call, decided on vercel") -> id
  // (remember '(lambda () (* 6 7)))                        -> id  (stores code)
  def("remember", (content) => store.remember(content));

  // (recall "what did we decide about hosting" 3)
  // -> ((id score "content") ...) ; recalling reinforces.
  def("recall", (query, n) =>
    store
      .recall(String(query), typeof n === "number" ? n : 5)
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

  // (replay id) -> evaluate the stored expression. Memory as program.
  def("replay", (id) => {
    const ep = store.get(String(id));
    if (!ep) throw new Error(`no episode ${id}`);
    return evaluate(ep.content, env);
  });

  // (decay!) -> ids tombstoned this pass
  def("decay!", () => store.decay());

  // (stats) -> ((episodes n) (live n) (forgotten n) (links n))
  def("stats", () => {
    const s = store.stats();
    return Object.entries(s).map(([k, v]) => [k, v]);
  });

  return env;
}

function round(x: number): number {
  return Math.round(x * 10000) / 10000;
}
