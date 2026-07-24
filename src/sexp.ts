// The universal representation. Everything in pentagram — data, code,
// queries, the on-disk log — is an S-expression.

export class Sym {
  constructor(public readonly name: string) {}
}

const interned = new Map<string, Sym>();
export function sym(name: string): Sym {
  let s = interned.get(name);
  if (!s) {
    s = new Sym(name);
    interned.set(name, s);
  }
  return s;
}

// Sexp = number | string | boolean | Sym | Sexp[] | Float32Array | function | closure
export type Sexp = any;

// ---------- Reader ----------

export function readAll(source: string): Sexp[] {
  const tokens = tokenize(source);
  const forms: Sexp[] = [];
  let pos = 0;
  const next = (): Sexp => {
    const tok = tokens[pos++];
    if (tok === undefined) throw new Error("unexpected end of input");
    if (tok === "(") {
      const list: Sexp[] = [];
      while (tokens[pos] !== ")") {
        if (tokens[pos] === undefined) throw new Error("unclosed (");
        list.push(next());
      }
      pos++; // consume )
      return list;
    }
    if (tok === ")") throw new Error("unexpected )");
    if (tok === "'") return [sym("quote"), next()];
    return atom(tok);
  };
  while (pos < tokens.length) forms.push(next());
  return forms;
}

export function read(source: string): Sexp {
  const forms = readAll(source);
  if (forms.length !== 1) throw new Error(`expected 1 form, got ${forms.length}`);
  return forms[0];
}

function tokenize(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ";") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === "(" || c === ")" || c === "'") {
      out.push(c);
      i++;
    } else if (c === '"') {
      let j = i + 1;
      let s = '"';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          s += src[j] + src[j + 1];
          j += 2;
        } else {
          s += src[j++];
        }
      }
      if (src[j] !== '"') throw new Error("unclosed string");
      out.push(s + '"');
      i = j + 1;
    } else {
      let j = i;
      while (j < src.length && !/[\s()';"]/.test(src[j])) j++;
      out.push(src.slice(i, j));
      i = j;
    }
  }
  return out;
}

function atom(tok: string): Sexp {
  if (tok.startsWith('"')) {
    return tok
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\\\/g, "\\");
  }
  if (tok === "true") return true;
  if (tok === "false") return false;
  const n = Number(tok);
  if (!Number.isNaN(n) && tok !== "") return n;
  return sym(tok);
}

// ---------- Printer ----------

export function print(x: Sexp): string {
  if (x === null || x === undefined) return "()";
  if (typeof x === "number") return String(x);
  if (typeof x === "boolean") return String(x);
  if (typeof x === "string")
    return '"' + x.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
  if (x instanceof Sym) return x.name;
  if (Array.isArray(x)) return "(" + x.map(print).join(" ") + ")";
  if (x instanceof Float32Array) return `#<vec${x.length}>`;
  if (typeof x === "function") return "#<native>";
  if (typeof x === "object" && x.__closure) return "#<closure>";
  return String(x);
}
