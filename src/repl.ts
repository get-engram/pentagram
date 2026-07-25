#!/usr/bin/env node
import * as readline from "node:readline";
import { Store } from "./store.js";
import { memoryEnv } from "./memory.js";
import { evaluate } from "./eval.js";
import { read, print } from "./sexp.js";
import { bestEmbedder } from "./embed.js";

const path = process.argv[2] ?? "memory.pgram";
const embedder = await bestEmbedder();
const store = await Store.open(path, embedder);
const env = memoryEnv(store);

console.log(`pentagram v0.2.0 — memory log: ${path} — embedder: ${embedder.name}`);
console.log(`try: (remember "hello world")  (recall "hello")  (stats)\n`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "⛧ " });
rl.prompt();
rl.on("line", async (line) => {
  const src = line.trim();
  if (src === "exit" || src === "quit") return rl.close();
  if (src) {
    try {
      console.log(print(await evaluate(read(src), env)));
    } catch (e: any) {
      console.error("error:", e.message);
    }
  }
  rl.prompt();
});
rl.on("close", () => {
  store.close();
  process.exit(0);
});
