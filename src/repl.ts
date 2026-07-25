#!/usr/bin/env node
import * as readline from "node:readline";
import * as fs from "node:fs";
import { Store } from "./store.js";
import { memoryEnv } from "./memory.js";
import { evaluate } from "./eval.js";
import { read, print } from "./sexp.js";
import { bestEmbedder } from "./embed.js";

const VERSION = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const arg = process.argv[2];
if (arg?.startsWith("-")) {
  // Flags are not filenames: without this, `pentagram --help` would create a
  // memory log literally named "--help".
  console.log(`pentagram v${VERSION} — a homoiconic memory substrate`);
  console.log(`usage: pentagram [memory-log-path]   (default: memory.pgram)`);
  console.log(`docs:  https://www.npmjs.com/package/pentagram-db`);
  process.exit(arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v" ? 0 : 1);
}

const path = arg ?? "memory.pgram";
const embedder = await bestEmbedder();
const store = await Store.open(path, embedder);
const env = memoryEnv(store);

console.log(`pentagram v${VERSION} — memory log: ${path} — embedder: ${embedder.name}`);
console.log(`try: (remember "hello world")  (recall "hello")  (stats)\n`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "⛧ " });
rl.prompt();

// Same drain discipline as the MCP server: piped stdin closes before async
// evaluations finish, and exiting early would swallow their output.
let pending = 0;
let closing = false;
const maybeExit = () => {
  if (closing && pending === 0) {
    store.close();
    process.exit(0);
  }
};
rl.on("line", async (line) => {
  const src = line.trim();
  if (src === "exit" || src === "quit") return rl.close();
  if (src) {
    pending++;
    try {
      console.log(print(await evaluate(read(src), env)));
    } catch (e: any) {
      console.error("error:", e.message);
    } finally {
      pending--;
      maybeExit();
    }
  }
  rl.prompt();
});
rl.on("close", () => {
  closing = true;
  maybeExit();
});
