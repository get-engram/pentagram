// Two layers, by design:
//
//   EXACT layer      — an append-only log of S-expressions on disk. Every event
//                      (episode, link, recalled, forget) is one immutable line.
//                      The log is the database, the audit trail, and valid Lisp.
//   ASSOCIATIVE layer — derived state folded from the log: embeddings, trace
//                      strength, the link graph. Mutable, reconstructable,
//                      and updated by observation (recall is a write).
//
// Nothing in the associative layer is truth; the log is truth.

import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Sexp, Sym, sym, readAll, print } from "./sexp.js";
import { embed, cosine } from "./embed.js";

export interface Episode {
  id: string;
  ts: number;
  content: Sexp; // string atom or arbitrary expression (procedural memory)
  text: string; // printed form, used for embedding
  embedding: Float32Array;
  forgotten: boolean;
}

export interface Trace {
  recallCount: number;
  lastAccess: number;
}

export interface Link {
  src: string;
  rel: string;
  dst: string;
}

export interface Recalled {
  id: string;
  score: number;
  similarity: number;
  episode: Episode;
}

const HALF_LIFE_HOURS = 24 * 30; // recency halves every 30 days
const REINFORCE_WEIGHT = 0.25; // each recall adds 25% strength

export class Store {
  private episodes = new Map<string, Episode>();
  private traces = new Map<string, Trace>();
  private links: Link[] = [];

  constructor(private path: string) {
    if (fs.existsSync(path)) {
      for (const event of readAll(fs.readFileSync(path, "utf8"))) this.fold(event);
    }
  }

  // ---------- exact layer ----------

  private append(event: Sexp): void {
    fs.appendFileSync(this.path, print(event) + "\n");
    this.fold(event);
  }

  private fold(event: Sexp): void {
    const [tag, ...rest] = event as [Sym, ...Sexp[]];
    switch (tag.name) {
      case "episode": {
        const [id, ts, content] = rest;
        const text = typeof content === "string" ? content : print(content);
        this.episodes.set(id, {
          id, ts, content, text,
          embedding: embed(text),
          forgotten: false,
        });
        this.traces.set(id, { recallCount: 0, lastAccess: ts });
        break;
      }
      case "link": {
        const [src, rel, dst] = rest;
        this.links.push({ src, rel: rel instanceof Sym ? rel.name : String(rel), dst });
        break;
      }
      case "recalled": {
        const [id, ts] = rest;
        const t = this.traces.get(id);
        if (t) {
          t.recallCount += 1;
          t.lastAccess = ts;
        }
        break;
      }
      case "forget": {
        const [id] = rest;
        const e = this.episodes.get(id);
        if (e) e.forgotten = true;
        break;
      }
    }
  }

  // ---------- API ----------

  remember(content: Sexp): string {
    const id = randomUUID().slice(0, 8);
    this.append([sym("episode"), id, Date.now(), content]);
    return id;
  }

  link(src: string, rel: string, dst: string): void {
    this.append([sym("link"), src, sym(rel), dst]);
  }

  // Observation is a write: recalling a memory reinforces it. The recall
  // events land in the same append-only log as everything else.
  recall(query: string, n = 5, now = Date.now()): Recalled[] {
    const qe = embed(query);
    const scored: Recalled[] = [];
    for (const ep of this.episodes.values()) {
      if (ep.forgotten) continue;
      const t = this.traces.get(ep.id)!;
      const similarity = cosine(qe, ep.embedding);
      const ageHours = Math.max(0, now - t.lastAccess) / 3_600_000;
      const recency = Math.pow(0.5, ageHours / HALF_LIFE_HOURS);
      const strength = 1 + REINFORCE_WEIGHT * t.recallCount;
      scored.push({ id: ep.id, score: similarity * recency * strength, similarity, episode: ep });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, n).filter((r) => r.similarity > 0);
    for (const r of top) this.append([sym("recalled"), r.id, now]);
    return top;
  }

  // Graph traversal: ids reachable within `depth` hops, with the relation path.
  hops(id: string, depth = 2): { id: string; via: string[] }[] {
    const seen = new Map<string, string[]>([[id, []]]);
    let frontier = [id];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const l of this.links) {
          const neighbor = l.src === cur ? l.dst : l.dst === cur ? l.src : null;
          if (neighbor && !seen.has(neighbor)) {
            seen.set(neighbor, [...seen.get(cur)!, l.rel]);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
    }
    seen.delete(id);
    return [...seen.entries()].map(([nid, via]) => ({ id: nid, via }));
  }

  // Forgetting is a feature: tombstone weak, stale memories. The episodes
  // stay in the log (exact layer is immutable); they just stop being recalled.
  decay(now = Date.now(), threshold = 0.05): string[] {
    const forgotten: string[] = [];
    for (const ep of this.episodes.values()) {
      if (ep.forgotten) continue;
      const t = this.traces.get(ep.id)!;
      const ageHours = (now - t.lastAccess) / 3_600_000;
      const strength = (1 + REINFORCE_WEIGHT * t.recallCount) * Math.pow(0.5, ageHours / HALF_LIFE_HOURS);
      if (strength < threshold) {
        this.append([sym("forget"), ep.id, now]);
        forgotten.push(ep.id);
      }
    }
    return forgotten;
  }

  get(id: string): Episode | undefined {
    return this.episodes.get(id);
  }

  trace(id: string): Trace | undefined {
    return this.traces.get(id);
  }

  stats() {
    const live = [...this.episodes.values()].filter((e) => !e.forgotten).length;
    return {
      episodes: this.episodes.size,
      live,
      forgotten: this.episodes.size - live,
      links: this.links.length,
    };
  }
}
