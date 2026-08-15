// One Durable Object per tenant: the platform IS the isolation model.
// A DO is single-threaded, so pentagram's single-writer invariant is
// guaranteed by construction (backend lock is a formality), and each
// tenant's log lives in the DO's own SQLite storage.

import { Store } from "../../src/store.js";
import { memoryEnv } from "../../src/memory.js";
import { evaluate, Env } from "../../src/eval.js";
import { read, print } from "../../src/sexp.js";
import { hashEmbedder, Embedder } from "../../src/embed.js";
import { extractiveSummarizer } from "../../src/summarize.js";
import { LogBackend } from "../../src/backend.js";

// ---------- LogBackend over Durable Object SQLite ----------

export class SqlLogBackend implements LogBackend {
  constructor(private sql: any /* SqlStorage */) {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS log (i INTEGER PRIMARY KEY AUTOINCREMENT, line TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS aux (name TEXT PRIMARY KEY, content TEXT NOT NULL)`);
  }

  describe(): string {
    return "<durable-object-sqlite>";
  }
  exists(): boolean {
    return this.sql.exec(`SELECT COUNT(*) AS n FROM log`).one().n > 0;
  }
  readText(): string {
    let out = "";
    for (const row of this.sql.exec(`SELECT line FROM log ORDER BY i`)) out += row.line;
    return out;
  }
  appendLine(line: string): void {
    this.sql.exec(`INSERT INTO log (line) VALUES (?)`, line);
  }
  sizeBytes(): number {
    return this.sql.exec(`SELECT COALESCE(SUM(LENGTH(line)), 0) AS n FROM log`).one().n;
  }
  replaceActive(content: string): void {
    this.sql.exec(`DELETE FROM log`);
    for (const line of content.split("\n")) {
      if (line.trim()) this.sql.exec(`INSERT INTO log (line) VALUES (?)`, line + "\n");
    }
  }
  archiveActive(name: string): void {
    this.writeAux(`archive-${name}`, this.readText());
    this.sql.exec(`DELETE FROM log`);
  }
  writeAux(name: string, content: string): void {
    this.sql.exec(`INSERT INTO aux (name, content) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET content = excluded.content`, name, content);
  }
  readAux(name: string): string | null {
    const rows = this.sql.exec(`SELECT content FROM aux WHERE name = ?`, name).toArray();
    return rows.length ? rows[0].content : null;
  }
  lock(): void {/* a Durable Object is single-threaded: locked by construction */}
  unlock(): void {}
  close(): void {}
}

// ---------- Workers AI embedder ----------

export function workersAiEmbedder(ai: any): Embedder {
  return {
    name: "workers-ai-bge-small-384",
    dim: 384,
    async embed(text: string): Promise<Float32Array> {
      const res = await ai.run("@cf/baai/bge-small-en-v1.5", { text: [text] });
      const v = new Float32Array(res.data[0]);
      let norm = 0;
      for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < v.length; i++) v[i] /= norm;
      return v;
    },
  };
}

// ---------- the tenant Durable Object ----------

interface WorkerEnv {
  AI?: any;
}

export class PentagramTenant {
  private session: Promise<{ st: Store; e: Env }> | null = null;

  constructor(
    private ctx: any /* DurableObjectState */,
    private env: WorkerEnv,
  ) {}

  private ensure(): Promise<{ st: Store; e: Env }> {
    return (this.session ??= (async () => {
      const backend = new SqlLogBackend(this.ctx.storage.sql);
      const embedder = this.env.AI ? workersAiEmbedder(this.env.AI) : hashEmbedder;
      const st = await Store.openWith(backend, embedder, extractiveSummarizer, {
        maxLogBytes: 8 * 1024 * 1024, // DO storage rows are cheap; snapshot at 8 MB
      });
      return { st, e: memoryEnv(st) };
    })());
  }

  // JSON-RPC in, JSON-RPC out. The worker routes authenticated MCP traffic
  // here; each DO handles exactly one tenant's memory.
  async fetch(request: Request): Promise<Response> {
    const rpc: any = await request.json();
    const { id, method, params } = rpc;
    const result = async (r: object) =>
      Response.json({ jsonrpc: "2.0", id, result: r });

    try {
      switch (method) {
        case "initialize":
          return result({
            protocolVersion: params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "pentagram-hosted", version: "0.8.0" },
          });
        case "ping":
          return result({});
        case "tools/list":
          return result({ tools: TOOLS });
        case "tools/call": {
          try {
            const text = await this.callTool(params.name, params.arguments ?? {});
            return result({ content: [{ type: "text", text }] });
          } catch (e: any) {
            return result({ content: [{ type: "text", text: `error: ${e.message}` }], isError: true });
          }
        }
        default:
          if (id === undefined) return new Response(null, { status: 202 }); // notification
          return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
      }
    } catch (e: any) {
      return Response.json({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
    }
  }

  private async callTool(name: string, args: any): Promise<string> {
    const { st, e } = await this.ensure();
    const run = (src: string) => evaluate(read(src), e);
    switch (name) {
      case "remember":
        if (args.code) return print(await run(`(remember '${String(args.code).trim()})`));
        return print(await st.remember(String(args.text ?? "")));
      case "recall": {
        const results = await st.recall(String(args.query), args.n ?? 5);
        return print(results.map((r) => [r.id, Math.round(r.score * 1e4) / 1e4, r.episode.text]));
      }
      case "touch":
        st.touch(String(args.id));
        return "()";
      case "link":
        st.link(String(args.src), String(args.rel), String(args.dst));
        return "()";
      case "hops":
        return print(st.hops(String(args.id), args.depth ?? 2).map((h) => [h.id, h.via]));
      case "stats":
        return print(Object.entries(st.stats()).map(([k, v]) => [k, v]));
      case "sleep": {
        const s = await st.sleepCycle();
        return print(Object.entries(s).map(([k, v]) => [k, v]));
      }
      case "eval":
        return print(await run(String(args.code)));
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }
}

const TOOLS = [
  { name: "remember", description: "Store a memory. `text` for plain memories, `code` for S-expressions (procedural memory). Returns the id.", inputSchema: { type: "object", properties: { text: { type: "string" }, code: { type: "string" } } } },
  { name: "recall", description: "Semantic recall scored by similarity² × recency × strength × importance. Recalling reinforces. Returns (id score text) triples.", inputSchema: { type: "object", properties: { query: { type: "string" }, n: { type: "number" } }, required: ["query"] } },
  { name: "touch", description: "Mark a memory as actually useful — a stronger reinforcement than passive recall.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "link", description: "Typed edge between two memories.", inputSchema: { type: "object", properties: { src: { type: "string" }, rel: { type: "string" }, dst: { type: "string" } }, required: ["src", "rel", "dst"] } },
  { name: "hops", description: "Graph traversal within depth hops (default 2).", inputSchema: { type: "object", properties: { id: { type: "string" }, depth: { type: "number" } }, required: ["id"] } },
  { name: "stats", description: "Store statistics.", inputSchema: { type: "object", properties: {} } },
  { name: "sleep", description: "One sleep cycle: decay → extract → consolidate.", inputSchema: { type: "object", properties: {} } },
  { name: "eval", description: "Evaluate a pentagram S-expression — the full language: (recall ...), (fact! text refs), (revise! id text refs), (sources id), (history id), (touch! id), (defmacro ...). The agent protocol is the language.", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
];
