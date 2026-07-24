// Two layers, by design:
//
//   EXACT layer      — an append-only log of S-expressions on disk. Every event
//                      (episode, fact, link, recalled, forget) is one immutable
//                      line. The log is the database, the audit trail, and
//                      valid Lisp.
//   ASSOCIATIVE layer — derived state folded from the log: embeddings, trace
//                      strength, the link graph. Mutable, reconstructable,
//                      and updated by observation (recall is a write).
//
// Nothing in the associative layer is truth; the log is truth. Embeddings are
// derived (never logged) so the embedder stays swappable; a sidecar cache
// (<log>.vecs.json, tagged by embedder) makes reopening cheap.

import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Sexp, Sym, sym, readAll, print } from "./sexp.js";
import { Embedder, hashEmbedder, cosine } from "./embed.js";
import { Summarizer, extractiveSummarizer } from "./summarize.js";

export interface Episode {
  id: string;
  ts: number;
  content: Sexp; // string atom or arbitrary expression (procedural memory)
  text: string; // printed form, used for embedding
  kind: "episode" | "fact" | "entity";
  provenance?: string[]; // for facts: the episode ids consolidated into it
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

export interface ConsolidateOptions {
  minAgeHours?: number; // only episodes at least this old are candidates
  threshold?: number; // cosine similarity to join a cluster
  now?: number;
  summarizer?: Summarizer; // defaults to extractive; claudeSummarizer for real compression
}

const HALF_LIFE_HOURS = 24 * 30; // recency halves every 30 days
const REINFORCE_WEIGHT = 0.25; // each recall adds 25% strength

export class Store {
  private episodes = new Map<string, Episode>();
  private traces = new Map<string, Trace>();
  private links: Link[] = [];
  private vecs = new Map<string, Float32Array>();
  private entityIds = new Map<string, string>(); // "name|kind" -> id

  private constructor(
    private path: string,
    readonly embedder: Embedder,
    readonly summarizer: Summarizer,
  ) {}

  /** Open (or create) a store: fold the log, then derive/restore embeddings. */
  static async open(
    path: string,
    embedder: Embedder = hashEmbedder,
    summarizer: Summarizer = extractiveSummarizer,
  ): Promise<Store> {
    const s = new Store(path, embedder, summarizer);
    if (fs.existsSync(path)) {
      for (const event of readAll(fs.readFileSync(path, "utf8"))) s.fold(event);
    }
    s.loadVecCache();
    await s.ensureVecs();
    s.saveVecCache();
    return s;
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
        this.episodes.set(id, { id, ts, content, text, kind: "episode", forgotten: false });
        this.traces.set(id, { recallCount: 0, lastAccess: ts });
        break;
      }
      case "fact": {
        const [id, ts, text, provenance] = rest;
        this.episodes.set(id, {
          id, ts, content: text, text, kind: "fact",
          provenance: provenance as string[], forgotten: false,
        });
        this.traces.set(id, { recallCount: 0, lastAccess: ts });
        break;
      }
      case "entity": {
        const [id, ts, name, kind] = rest;
        const kindName = kind instanceof Sym ? kind.name : String(kind);
        this.episodes.set(id, {
          id, ts, content: name, text: `${name} (${kindName})`, kind: "entity", forgotten: false,
        });
        this.traces.set(id, { recallCount: 0, lastAccess: ts });
        this.entityIds.set(`${name}|${kindName}`, id);
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

  // ---------- derived embeddings + sidecar cache ----------

  private vecCachePath(): string {
    return this.path + ".vecs.json";
  }

  private loadVecCache(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.vecCachePath(), "utf8"));
      if (raw.embedder !== this.embedder.name) return; // embedder changed: re-derive
      for (const [id, b64] of Object.entries<string>(raw.vecs)) {
        if (this.episodes.has(id)) {
          const buf = Buffer.from(b64, "base64");
          this.vecs.set(id, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
        }
      }
    } catch {
      /* no cache or unreadable: re-derive everything */
    }
  }

  private saveVecCache(): void {
    const vecs: Record<string, string> = {};
    for (const [id, v] of this.vecs) {
      vecs[id] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
    }
    fs.writeFileSync(this.vecCachePath(), JSON.stringify({ embedder: this.embedder.name, vecs }));
  }

  private async ensureVecs(): Promise<void> {
    for (const ep of this.episodes.values()) {
      if (!this.vecs.has(ep.id)) this.vecs.set(ep.id, await this.embedder.embed(ep.text));
    }
  }

  // ---------- API ----------

  async remember(content: Sexp, ts = Date.now()): Promise<string> {
    const id = randomUUID().slice(0, 8);
    this.append([sym("episode"), id, ts, content]);
    this.vecs.set(id, await this.embedder.embed(this.episodes.get(id)!.text));
    this.saveVecCache();
    return id;
  }

  link(src: string, rel: string, dst: string): void {
    this.append([sym("link"), src, sym(rel), dst]);
  }

  // Entities are first-class memories: recallable (they embed like anything
  // else), traversable (link episodes to them), and deduplicated by name+kind
  // so every mention converges on one node in the graph.
  async entity(name: string, kind = "thing", ts = Date.now()): Promise<string> {
    const existing = this.entityIds.get(`${name}|${kind}`);
    if (existing) return existing;
    const id = randomUUID().slice(0, 8);
    this.append([sym("entity"), id, ts, name, sym(kind)]);
    this.vecs.set(id, await this.embedder.embed(this.episodes.get(id)!.text));
    this.saveVecCache();
    return id;
  }

  // Observation is a write: recalling a memory reinforces it. The recall
  // events land in the same append-only log as everything else.
  async recall(query: string, n = 5, now = Date.now()): Promise<Recalled[]> {
    const qe = await this.embedder.embed(query);
    const scored: Recalled[] = [];
    for (const ep of this.episodes.values()) {
      if (ep.forgotten) continue;
      const t = this.traces.get(ep.id)!;
      const similarity = cosine(qe, this.vecs.get(ep.id)!);
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
      if (ep.kind === "entity") continue; // entities persist; only experiences fade
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

  // Consolidation, v0: sleep as ETL. Cluster old, similar episodes and compress
  // each cluster into a provenance-carrying fact; the sources are tombstoned
  // (but remain in the log — provenance always resolves). The summarizer here
  // is extractive and dumb by design; an LLM summarizer plugs in behind the
  // same event shape without changing the log format.
  async consolidate(opts: ConsolidateOptions = {}): Promise<string[]> {
    const {
      minAgeHours = 24 * 7,
      threshold = 0.55,
      now = Date.now(),
      summarizer = this.summarizer,
    } = opts;
    const candidates = [...this.episodes.values()].filter(
      (e) => !e.forgotten && e.kind === "episode" && now - e.ts >= minAgeHours * 3_600_000,
    );
    const clustered = new Set<string>();
    const factIds: string[] = [];

    for (const seed of candidates) {
      if (clustered.has(seed.id)) continue;
      const cluster = [seed];
      for (const other of candidates) {
        if (other.id === seed.id || clustered.has(other.id)) continue;
        if (cosine(this.vecs.get(seed.id)!, this.vecs.get(other.id)!) >= threshold) {
          cluster.push(other);
        }
      }
      if (cluster.length < 2) continue;

      for (const e of cluster) clustered.add(e.id);
      const ids = cluster.map((e) => e.id);
      const summary = await summarizer(cluster.map((e) => e.text));

      const factId = randomUUID().slice(0, 8);
      this.append([sym("fact"), factId, now, summary, ids]);
      this.vecs.set(factId, await this.embedder.embed(summary));
      for (const id of ids) this.append([sym("forget"), id, now]);
      factIds.push(factId);
    }
    if (factIds.length) this.saveVecCache();
    return factIds;
  }

  get(id: string): Episode | undefined {
    return this.episodes.get(id);
  }

  trace(id: string): Trace | undefined {
    return this.traces.get(id);
  }

  stats() {
    const all = [...this.episodes.values()];
    const live = all.filter((e) => !e.forgotten);
    return {
      episodes: all.filter((e) => e.kind === "episode").length,
      facts: all.filter((e) => e.kind === "fact").length,
      entities: all.filter((e) => e.kind === "entity").length,
      live: live.length,
      forgotten: all.length - live.length,
      links: this.links.length,
      embedder: this.embedder.name,
    };
  }
}
