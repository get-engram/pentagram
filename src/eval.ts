// A small Lisp evaluator. The same evaluator runs user queries at the REPL
// and replays stored procedural memories — there is only one language here.

import { Sexp, Sym, sym, print } from "./sexp.js";

export class Env {
  private vars = new Map<string, Sexp>();
  constructor(private parent?: Env) {}

  get(name: string): Sexp {
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent) return this.parent.get(name);
    throw new Error(`unbound symbol: ${name}`);
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

export function evaluate(expr: Sexp, env: Env): Sexp {
  if (expr instanceof Sym) return env.get(expr.name);
  if (!Array.isArray(expr)) return expr; // self-evaluating atom
  if (expr.length === 0) return [];

  const head = expr[0];
  if (head instanceof Sym) {
    switch (head.name) {
      case "quote":
        return expr[1];
      case "if":
        return truthy(evaluate(expr[1], env))
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
        return env.define((target as Sym).name, evaluate(expr[2], env));
      }
      case "set!":
        return env.set((expr[1] as Sym).name, evaluate(expr[2], env));
      case "lambda":
        return makeClosure(expr[1] as Sym[], expr.slice(2), env);
      case "let": {
        const inner = new Env(env);
        for (const [name, value] of expr[1] as [Sym, Sexp][]) {
          inner.define(name.name, evaluate(value, inner));
        }
        return evalBody(expr.slice(2), inner);
      }
      case "begin":
        return evalBody(expr.slice(1), env);
      case "and": {
        let v: Sexp = true;
        for (const e of expr.slice(1)) {
          v = evaluate(e, env);
          if (!truthy(v)) return v;
        }
        return v;
      }
      case "or": {
        for (const e of expr.slice(1)) {
          const v = evaluate(e, env);
          if (truthy(v)) return v;
        }
        return false;
      }
    }
  }

  const fn = evaluate(head, env);
  const args = expr.slice(1).map((a) => evaluate(a, env));
  return apply(fn, args);
}

export function apply(fn: Sexp, args: Sexp[]): Sexp {
  if (typeof fn === "function") return fn(...args);
  if (fn && fn.__closure) {
    const c = fn as Closure;
    const inner = new Env(c.env);
    c.params.forEach((p, i) => inner.define(p, args[i]));
    return evalBody(c.body, inner);
  }
  throw new Error(`not callable: ${print(fn)}`);
}

function makeClosure(params: Sym[], body: Sexp[], env: Env): Closure {
  return { __closure: true, params: params.map((p) => p.name), body, env };
}

function evalBody(body: Sexp[], env: Env): Sexp {
  let result: Sexp = [];
  for (const form of body) result = evaluate(form, env);
  return result;
}

export function truthy(x: Sexp): boolean {
  return !(x === false || (Array.isArray(x) && x.length === 0));
}

// ---------- Core builtins (language-level; memory builtins live in memory.ts) ----------

export function coreEnv(): Env {
  const env = new Env();
  const def = (name: string, fn: (...args: Sexp[]) => Sexp) => env.define(name, fn);

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
  def("map", (fn, l) => l.map((x: Sexp) => apply(fn, [x])));
  def("filter", (fn, l) => l.filter((x: Sexp) => truthy(apply(fn, [x]))));
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
