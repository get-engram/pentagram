// A small Lisp evaluator. The same evaluator runs user queries at the REPL,
// serves the MCP agent protocol, and replays stored procedural memories —
// there is only one language here.
//
// Async throughout: memory operations (embedding, recall) return promises,
// and the evaluator awaits natives transparently.

import { Sexp, Sym, print } from "./sexp.js";

export class Env {
  private vars = new Map<string, Sexp>();
  constructor(private parent?: Env) {}

  get(name: string): Sexp {
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent) return this.parent.get(name);
    throw new Error(`unbound symbol: ${name}`);
  }
  tryGet(name: string): Sexp | undefined {
    if (this.vars.has(name)) return this.vars.get(name);
    return this.parent?.tryGet(name);
  }
  define(name: string, value: Sexp): Sexp {
    this.vars.set(name, value);
    return value;
  }
  set(name: string, value: Sexp): Sexp {
    if (this.vars.has(name)) {
      this.vars.set(name, value);
      return value;
    }
    if (this.parent) return this.parent.set(name, value);
    throw new Error(`set! of unbound symbol: ${name}`);
  }
}

interface Closure {
  __closure: true;
  params: string[];
  body: Sexp[];
  env: Env;
}

interface Macro {
  __macro: true;
  closure: Closure;
}

export async function evaluate(expr: Sexp, env: Env): Promise<Sexp> {
  if (expr instanceof Sym) return env.get(expr.name);
  if (!Array.isArray(expr)) return expr; // self-evaluating atom
  if (expr.length === 0) return [];

  const head = expr[0];
  if (head instanceof Sym) {
    switch (head.name) {
      case "quote":
        return expr[1];
      case "quasiquote":
        return quasi(expr[1], env);
      case "if":
        return truthy(await evaluate(expr[1], env))
          ? evaluate(expr[2], env)
          : expr.length > 3
            ? evaluate(expr[3], env)
            : [];
      case "define": {
        const target = expr[1];
        if (Array.isArray(target)) {
          // (define (f a b) body...) sugar
          const [name, ...params] = target as Sym[];
          return env.define(name.name, makeClosure(params, expr.slice(2), env));
        }
        return env.define((target as Sym).name, await evaluate(expr[2], env));
      }
      case "defmacro": {
        // (defmacro name (params...) body...) — the body receives UNevaluated
        // argument forms and returns a form, which is then evaluated. Code
        // that writes code: the language grows itself from inside.
        const name = expr[1] as Sym;
        const closure = makeClosure(expr[2] as Sym[], expr.slice(3), env);
        const macro: Macro = { __macro: true, closure };
        return env.define(name.name, macro);
      }
      case "set!":
        return env.set((expr[1] as Sym).name, await evaluate(expr[2], env));
      case "lambda":
        return makeClosure(expr[1] as Sym[], expr.slice(2), env);
      case "let": {
        const inner = new Env(env);
        for (const [name, value] of expr[1] as [Sym, Sexp][]) {
          inner.define(name.name, await evaluate(value, inner));
        }
        return evalBody(expr.slice(2), inner);
      }
      case "begin":
        return evalBody(expr.slice(1), env);
      case "and": {
        let v: Sexp = true;
        for (const e of expr.slice(1)) {
          v = await evaluate(e, env);
          if (!truthy(v)) return v;
        }
        return v;
      }
      case "or": {
        for (const e of expr.slice(1)) {
          const v = await evaluate(e, env);
          if (truthy(v)) return v;
        }
        return false;
      }
    }

    // Macro expansion: apply to unevaluated args, then evaluate the expansion.
    const binding = env.tryGet(head.name);
    if (binding && binding.__macro) {
      const expansion = await apply((binding as Macro).closure, expr.slice(1));
      return evaluate(expansion, env);
    }
  }

  const fn = await evaluate(head, env);
  const args: Sexp[] = [];
  for (const a of expr.slice(1)) args.push(await evaluate(a, env));
  return apply(fn, args);
}

export async function apply(fn: Sexp, args: Sexp[]): Promise<Sexp> {
  if (typeof fn === "function") return await fn(...args);
  if (fn && fn.__closure) {
    const c = fn as Closure;
    const inner = new Env(c.env);
    c.params.forEach((p, i) => inner.define(p, args[i]));
    return evalBody(c.body, inner);
  }
  throw new Error(`not callable: ${print(fn)}`);
}

// `(a ,x ,@xs) — template with holes. Single-level (no nested quasiquote).
async function quasi(x: Sexp, env: Env): Promise<Sexp> {
  if (!Array.isArray(x)) return x;
  if (x[0] instanceof Sym && x[0].name === "unquote") return evaluate(x[1], env);
  const out: Sexp[] = [];
  for (const item of x) {
    if (Array.isArray(item) && item[0] instanceof Sym && item[0].name === "unquote-splicing") {
      const spliced = await evaluate(item[1], env);
      out.push(...spliced);
    } else {
      out.push(await quasi(item, env));
    }
  }
  return out;
}

function makeClosure(params: Sym[], body: Sexp[], env: Env): Closure {
  return { __closure: true, params: params.map((p) => p.name), body, env };
}

async function evalBody(body: Sexp[], env: Env): Promise<Sexp> {
  let result: Sexp = [];
  for (const form of body) result = await evaluate(form, env);
  return result;
}

export function truthy(x: Sexp): boolean {
  return !(x === false || (Array.isArray(x) && x.length === 0));
}

// ---------- Core builtins (language-level; memory builtins live in memory.ts) ----------

export function coreEnv(): Env {
  const env = new Env();
  const def = (name: string, fn: (...args: Sexp[]) => Sexp | Promise<Sexp>) =>
    env.define(name, fn);

  def("+", (...ns) => ns.reduce((a: number, b: number) => a + b, 0));
  def("-", (a, ...ns) => (ns.length ? ns.reduce((x: number, y: number) => x - y, a) : -a));
  def("*", (...ns) => ns.reduce((a: number, b: number) => a * b, 1));
  def("/", (a, b) => a / b);
  def("=", (a, b) => eq(a, b));
  def("<", (a, b) => a < b);
  def(">", (a, b) => a > b);
  def("not", (a) => !truthy(a));
  def("list", (...xs) => xs);
  def("car", (l) => (l.length ? l[0] : []));
  def("cdr", (l) => l.slice(1));
  def("cons", (x, l) => [x, ...l]);
  def("length", (l) => l.length);
  def("nth", (l, i) => l[i]);
  def("map", async (fn, l) => {
    const out: Sexp[] = [];
    for (const x of l) out.push(await apply(fn, [x]));
    return out;
  });
  def("filter", async (fn, l) => {
    const out: Sexp[] = [];
    for (const x of l) if (truthy(await apply(fn, [x]))) out.push(x);
    return out;
  });
  def("str", (...xs) =>
    xs.map((x) => (typeof x === "string" ? x : print(x))).join(""));
  def("print", (...xs) => {
    console.log(xs.map((x) => (typeof x === "string" ? x : print(x))).join(" "));
    return [];
  });
  return env;
}

function eq(a: Sexp, b: Sexp): boolean {
  if (a instanceof Sym && b instanceof Sym) return a.name === b.name;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  return a === b;
}
