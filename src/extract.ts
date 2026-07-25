// Pluggable entity extractors. Extraction turns raw episode text into graph
// structure: entity nodes plus `mentions` links. Like the summarizer, the
// LLM-backed extractor shells out to the `claude` CLI headless — and it
// replies in S-expressions, parsed by pentagram's own reader. One language.

import { execFile } from "node:child_process";
import { readAll, Sym } from "./sexp.js";

export interface ExtractedEntity {
  name: string;
  kind: string;
}

export type Extractor = (text: string) => Promise<ExtractedEntity[]>;

const KINDS = new Set(["person", "org", "client", "project", "place", "product", "thing"]);

export function claudeExtractor(model = "haiku"): Extractor {
  return (text) =>
    new Promise((resolve, reject) => {
      const prompt =
        "Extract the named entities from this memory episode. Reply ONLY with an " +
        'S-expression list of (name kind) pairs, e.g. (("acme corp" client) ("ahmad" person)). ' +
        "Lowercase the names. kind must be one of: person, org, client, project, place, " +
        "product, thing. If there are no named entities reply with ().\n\nEpisode: " + text;
      execFile(
        "claude",
        ["-p", prompt, "--model", model],
        { timeout: 120_000, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err) return reject(new Error(`claude extractor failed: ${err.message}`));
          try {
            resolve(parseEntities(stdout));
          } catch (e: any) {
            reject(new Error(`claude extractor returned unparseable output: ${e.message}`));
          }
        },
      );
    });
}

/** Parse (("name" kind) ...) — tolerant of surrounding prose lines. */
export function parseEntities(output: string): ExtractedEntity[] {
  // Find the first balanced top-level form that starts with "((" or is "()".
  const start = output.indexOf("(");
  if (start === -1) return [];
  const forms = readAll(balancedPrefix(output.slice(start)));
  const list = forms[0];
  if (!Array.isArray(list)) return [];
  const out: ExtractedEntity[] = [];
  for (const pair of list) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const name = String(pair[0]).trim().toLowerCase();
    const kind = (pair[1] instanceof Sym ? pair[1].name : String(pair[1])).toLowerCase();
    if (name && KINDS.has(kind)) out.push({ name, kind });
  }
  return out;
}

function balancedPrefix(s: string): string {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return s.slice(0, i + 1);
    }
  }
  return s;
}

/** claudeExtractor if the claude CLI is on PATH, else null (extraction off). */
export function bestExtractor(): Promise<Extractor | null> {
  return new Promise((resolve) => {
    execFile("claude", ["--version"], { timeout: 10_000 }, (err) =>
      resolve(err ? null : claudeExtractor()),
    );
  });
}
