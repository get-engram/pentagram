#!/usr/bin/env node
// MCP server over stdio: pentagram as a memory substrate for any agent.
// Hand-rolled JSON-RPC (newline-delimited, per the MCP stdio transport) —
// no SDK, keeping the zero-runtime-dependency core.
//
//   claude mcp add pentagram -- npx tsx src/mcp.ts
//   env: PENTAGRAM_LOG (default memory.pgram), PENTAGRAM_EMBEDDER (semantic|hash)
//
// The `eval` tool exposes the full language to the agent. That is the point —
// the agent protocol IS the language — but it is arbitrary code execution by
// design: single-user, local, trusted-agent deployments only (paper §8).

import * as readline from "node:readline";
import { Store } from "./store.js";
import { memoryEnv } from "./memory.js";
import { evaluate, Env } from "./eval.js";
import { read, print } from "./sexp.js";
import { bestEmbedder, hashEmbedder, semanticEmbedder, disposeEmbedder } from "./embed.js";
import { bestSummarizer, claudeSummarizer, extractiveSummarizer } from "./summarize.js";
import { bestExtractor, claudeExtractor } from "./extract.js";
import { Tenants } from "./tenants.js";

const LOG_PATH = process.env.PENTAGRAM_LOG ?? "memory.pgram";

// Concurrent tool calls race into initialization, so every lazy singleton
// here memoizes its PROMISE, not its result — one open, everyone awaits it.
// (Learned the hard way: caching the result let N concurrent calls all try
// to open the store, and the single-writer lock correctly refused N-1.)

interface Session {
  st: Store;
  e: Env;
}

interface Config {
  embedder: any;
  summarizer: any;
  extractor: any;
}

let cfgPromise: Promise<Config> | null = null;
function config(): Promise<Config> {
  return (cfgPromise ??= (async () => {
    const embedder =
      process.env.PENTAGRAM_EMBEDDER === "hash" ? hashEmbedder
      : process.env.PENTAGRAM_EMBEDDER === "semantic" ? semanticEmbedder
      : await bestEmbedder();
    const summarizer =
      process.env.PENTAGRAM_SUMMARIZER === "extractive" ? extractiveSummarizer
      : process.env.PENTAGRAM_SUMMARIZER === "claude" ? claudeSummarizer()
      : await bestSummarizer();
    const extractor =
      process.env.PENTAGRAM_EXTRACTOR === "off" ? null
      : process.env.PENTAGRAM_EXTRACTOR === "claude" ? claudeExtractor()
      : await bestExtractor();
    return { embedder, summarizer, extractor };
  })());
}

let mainPromise: Promise<Session> | null = null;
function mainSession(): Promise<Session> {
  return (mainPromise ??= (async () => {
    const c = await config();
    const st = await Store.open(LOG_PATH, c.embedder, c.summarizer, { extractor: c.extractor });

    // Scheduled sleep: PENTAGRAM_SLEEP=<minutes> runs decay → extract →
    // consolidate on a timer. Off by default (extraction/summarization may
    // call an LLM; scheduling that is an explicit choice).
    const sleepMin = Number(process.env.PENTAGRAM_SLEEP ?? 0);
    if (sleepMin > 0) {
      const timer = setInterval(() => {
        st.sleepCycle().catch(() => {/* sleep is best-effort; next tick retries */});
      }, sleepMin * 60_000);
      timer.unref?.();
    }
    return { st, e: memoryEnv(st) };
  })());
}

let tenantsPromise: Promise<Tenants> | null = null;
function getTenants(): Promise<Tenants> {
  return (tenantsPromise ??= (async () => {
    const c = await config();
    return new Tenants(LOG_PATH + ".tenants", c.embedder, c.summarizer, { extractor: c.extractor });
  })());
}

const tenantSessions = new Map<string, Promise<Session>>();
function tenantSession(name: string): Promise<Session> {
  let p = tenantSessions.get(name);
  if (!p) {
    p = (async () => {
      const st = await (await getTenants()).get(name);
      return { st, e: memoryEnv(st) };
    })();
    tenantSessions.set(name, p);
  }
  return p;
}

// Tenant isolation: `tenant` on any tool routes to a fully separate store
// (own log/lock/caches/environment) under <log>.tenants/. No tenant = the
// default store, exactly as before.
function resolve(tenant?: string): Promise<Session> {
  return tenant ? tenantSession(tenant) : mainSession();
}

const TOOLS = [
  {
    name: "remember",
    description:
      "Store a memory in the append-only episodic log. Returns the memory id. " +
      "`text` stores a plain memory; `code` stores an S-expression (procedural memory).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "memory content (plain text)" },
        code: { type: "string", description: "an S-expression to store instead of text" },
      },
    },
  },
  {
    name: "recall",
    description:
      "Semantic recall over stored memories, scored by similarity x recency x strength. " +
      "Recalling a memory reinforces it. Returns (id score text) triples.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        n: { type: "number", description: "max results (default 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "link",
    description: "Create a typed edge between two memories: link(src, rel, dst).",
    inputSchema: {
      type: "object",
      properties: {
        src: { type: "string" },
        rel: { type: "string", description: "relation name, e.g. 'about'" },
        dst: { type: "string" },
      },
      required: ["src", "rel", "dst"],
    },
  },
  {
    name: "hops",
    description: "Graph traversal: memories reachable from id within depth hops (default 2).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        depth: { type: "number" },
      },
      required: ["id"],
    },
  },
  {
    name: "stats",
    description: "Store statistics: episode/fact/live/forgotten counts, links, embedder.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sleep",
    description:
      "Run one sleep cycle: decay stale memories, extract entities from new " +
      "episodes, consolidate similar old episodes into provenance-carrying facts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "eval",
    description:
      "Evaluate a pentagram S-expression directly — the full language: " +
      "(recall ...), (remember ...), (replay id), (sleep!), (consolidate!), " +
      "(extract!), (decay!), (defmacro ...), lambdas, map/filter. " +
      "The agent protocol is the language.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", description: "S-expression source" } },
      required: ["code"],
    },
  },
];

// Every tool accepts an optional `tenant` for isolated per-tenant stores.
for (const t of TOOLS) {
  (t.inputSchema.properties as any).tenant = {
    type: "string",
    description: "optional isolated tenant store (lowercase alphanumeric, - and _)",
  };
}

async function callTool(name: string, args: any): Promise<string> {
  const { st, e } = await resolve(args.tenant ? String(args.tenant) : undefined);
  const run = (src: string) => evaluate(read(src), e);
  switch (name) {
    case "remember": {
      if (args.code) return print(await run(`(remember '${args.code.trim()})`));
      return print(await st.remember(String(args.text ?? "")));
    }
    case "recall": {
      const results = await st.recall(String(args.query), args.n ?? 5);
      return print(results.map((r) => [r.id, Math.round(r.score * 1e4) / 1e4, r.episode.text]));
    }
    case "link": {
      st.link(String(args.src), String(args.rel), String(args.dst));
      return "()";
    }
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

// ---------- JSON-RPC over stdio ----------

function send(msg: object): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const rl = readline.createInterface({ input: process.stdin });

// Don't exit while tool calls are in flight: stdin closing (e.g. piped
// input) must not drop responses that are still being computed.
let pending = 0;
let closing = false;
async function maybeExit(): Promise<void> {
  if (closing && pending === 0) {
    try {
      if (mainPromise) (await mainPromise).st.close();
      if (tenantsPromise) await (await tenantsPromise).close();
    } catch {
      /* close is best-effort on the way out */
    }
    await disposeEmbedder();
    process.exit(0);
  }
}
rl.on("close", () => {
  closing = true;
  void maybeExit();
});
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let req: any;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  pending++;
  try {
    await handle(req);
  } finally {
    pending--;
    void maybeExit();
  }
});

async function handle(req: any): Promise<void> {
  const { id, method, params } = req;
  const respond = (result: object) => id !== undefined && send({ jsonrpc: "2.0", id, result });

  try {
    switch (method) {
      case "initialize":
        respond({
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "pentagram", version: "0.6.1" },
        });
        break;
      case "ping":
        respond({});
        break;
      case "tools/list":
        respond({ tools: TOOLS });
        break;
      case "tools/call": {
        try {
          const text = await callTool(params.name, params.arguments ?? {});
          respond({ content: [{ type: "text", text }] });
        } catch (e: any) {
          respond({ content: [{ type: "text", text: `error: ${e.message}` }], isError: true });
        }
        break;
      }
      default:
        // notifications (no id) are ignored; unknown requests get an error
        if (id !== undefined) {
          send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
        }
    }
  } catch (e: any) {
    if (id !== undefined) {
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
    }
  }
}
