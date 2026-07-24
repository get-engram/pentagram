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

const LOG_PATH = process.env.PENTAGRAM_LOG ?? "memory.pgram";

let store: Store | null = null;
let env: Env | null = null;

async function ensure(): Promise<Env> {
  if (!env) {
    const embedder =
      process.env.PENTAGRAM_EMBEDDER === "hash" ? hashEmbedder
      : process.env.PENTAGRAM_EMBEDDER === "semantic" ? semanticEmbedder
      : await bestEmbedder();
    store = await Store.open(LOG_PATH, embedder);
    env = memoryEnv(store);
  }
  return env;
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
    name: "eval",
    description:
      "Evaluate a pentagram S-expression directly — the full language: " +
      "(recall ...), (remember ...), (replay id), (consolidate!), (decay!), " +
      "(defmacro ...), lambdas, map/filter. The agent protocol is the language.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", description: "S-expression source" } },
      required: ["code"],
    },
  },
];

async function callTool(name: string, args: any): Promise<string> {
  const e = await ensure();
  const run = (src: string) => evaluate(read(src), e);
  switch (name) {
    case "remember": {
      if (args.code) return print(await run(`(remember '${args.code.trim()})`));
      return print(await store!.remember(String(args.text ?? "")));
    }
    case "recall": {
      const results = await store!.recall(String(args.query), args.n ?? 5);
      return print(results.map((r) => [r.id, Math.round(r.score * 1e4) / 1e4, r.episode.text]));
    }
    case "link": {
      store!.link(String(args.src), String(args.rel), String(args.dst));
      return "()";
    }
    case "hops":
      return print(store!.hops(String(args.id), args.depth ?? 2).map((h) => [h.id, h.via]));
    case "stats":
      return print(Object.entries(store!.stats()).map(([k, v]) => [k, v]));
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
rl.on("close", async () => {
  await disposeEmbedder();
  process.exit(0);
});
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let req: any;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  const respond = (result: object) => id !== undefined && send({ jsonrpc: "2.0", id, result });

  try {
    switch (method) {
      case "initialize":
        respond({
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "pentagram", version: "0.2.0" },
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
});
