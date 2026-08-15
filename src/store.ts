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
import * as nodePath from "node:path";
import { randomUUID } from "node:crypto";
import { Sexp, Sym, sym, readAll, print } from "./sexp.js";
import { Embedder, hashEmbedder, cosine } from "./embed.js";
import { Summarizer, extractiveSummarizer } from "./summarize.js";
import { Extractor } from "./extract.js";
import { HNSW } from "./hnsw.js";

// A provenance entry is either a bare episode id ("a1b2c3d4") or a structured
// external reference: (system ref [as-of-ms]), e.g. (postgres "invoices/1234"
// 1755212000000). Kept as raw Sexp — homoiconicity means provenance needs no
// schema of its own; it prints, folds, and round-trips like everything else.
export type ProvRef = Sexp;

export interface Episode {
  id: string;
  ts: number;
  content: Sexp; // string atom or arbitrary expression (procedural memory)
  text: string; // printed form, used for embedding
  kind: "episode" | "fact" | "entity";
  provenance?: ProvRef[]; // for facts: episode ids and/or external references
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

export interface ExtractOptions {
  extractor?: Extractor; // defaults to the store's configured extractor
  limit?: number; // max episodes per pass (extraction can call an LLM)
  now?: number;
}

export interface StoreOptions {
  extractor?: Extractor | null; // default entity extractor (null = extraction off)
  maxLogBytes?: number; // active-log rollover threshold; Infinity disables
  fsync?: boolean; // fsync every append (durability over throughput); default off
}

const HALF_LIFE_HOURS = 24 * 30; // recency halves every 30 days
const REINFORCE_WEIGHT = 0.5; // reinforcement weight (log-damped: 10 recalls ≈ 2.2x, 100 ≈ 3.3x)
const DEGREE_WEIGHT = 0.15; // importance: well-connected memories rank higher
const TOUCH_WEIGHT = 3; // one explicit touch counts as this many passive recalls
const ANN_THRESHOLD = 2000; // below this, exact full scan; above, HNSW
const ANN_OVERSAMPLE = 8; // fetch n*this from the index before rescoring
const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024; // roll the active log at 10 MB
const EXTRACT_BATCH = 20; // default episodes per extraction pass

export class Store {
  private episodes = new Map<string, Episode>();
  private traces = new Map<string, Trace>();
  private links: Link[] = [];
  private vecs = new Map<string, Float32Array>();
  private entityIds = new Map<string, string>(); // "name|kind" -> id
  private degree = new Map<string, number>(); // link count per id
  private extracted = new Set<string>(); // episode ids already entity-extracted
  private index: HNSW | null = null; // derived, disposable, built past ANN_THRESHOLD

  private constructor(
    private path: string,
    readonly embedder: Embedder,
    readonly summarizer: Summarizer,
    readonly extractor: Extractor | null,
    private maxLogBytes: number,
    private fsync: boolean,
  ) {}

  private fd: number | null = null; // persistent append fd (fsync mode only)

  /** Open (or create) a store: fold the log, then derive/restore embeddings. */
  static async open(
    path: string,
    embedder: Embedder = hashEmbedder,
    summarizer: Summarizer = extractiveSummarizer,
    opts: StoreOptions = {},
  ): Promise<Store> {
    const s = new Store(path, embedder, summarizer, opts.extractor ?? null,
      opts.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES, opts.fsync ?? false);
    s.acquireLock();
    if (fs.existsSync(path)) {
      s.loadAndFold();
      s.maybeRollover();
    }
    s.loadVecCache();
    await s.ensureVecs();
    s.saveVecCache();
    return s;
  }

  // Crash-safe load. Events are one per line by construction (print() escapes
  // newlines), so the log parses line-by-line. A malformed FINAL line is a
  // torn write from a crash mid-append: the event was never durable, so we
  // quarantine the bytes (<log>.torn-<ts>) and truncate — recovery, not data
  // loss. A malformed line anywhere ELSE is real corruption: fail loudly.
  private loadAndFold(): void {
    const lines = fs.readFileSync(this.path, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let events: Sexp[];
      try {
        events = readAll(line);
      } catch (e: any) {
        const isLastContent = lines.slice(i + 1).every((l) => !l.trim());
        if (isLastContent) {
          fs.writeFileSync(`${this.path}.torn-${Date.now()}`, lines[i]);
          fs.writeFileSync(this.path, i ? lines.slice(0, i).join("\n") + "\n" : "");
          return;
        }
        throw new Error(`corrupt log ${this.path} at line ${i + 1}: ${e.message}`);
      }
      for (const ev of events) this.fold(ev);
    }
  }

  // ---------- single-writer lock ----------
  //
  // The append-only log has exactly one writer. A lockfile (<log>.lock,
  // holding the owner pid) makes that a checked invariant instead of a hope:
  // a second open of the same log throws. Locks from dead processes are
  // stolen automatically, so crashes never wedge the store.

  private lockPath(): string {
    return this.path + ".lock";
  }

  private acquireLock(): void {
    const tryAcquire = () =>
      fs.writeFileSync(this.lockPath(), String(process.pid), { flag: "wx" });
    try {
      tryAcquire();
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      const holder = Number(fs.readFileSync(this.lockPath(), "utf8"));
      // Our own pid counts as a live holder too: a second Store instance in
      // the same process is still a second writer.
      if (holder && (holder === process.pid || isAlive(holder))) {
        throw new Error(`memory log ${this.path} is locked by running process ${holder}`);
      }
      fs.unlinkSync(this.lockPath()); // stale (dead holder): steal it
      tryAcquire();
    }
    this.locked = true;
  }

  private locked = false;

  /** Flush derived caches and release the writer lock. */
  close(): void {
    if (this.cacheTimer) {
      clearTimeout(this.cacheTimer);
      this.cacheTimer = null;
    }
    this.flush();
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
    if (this.locked) {
      try {
        if (Number(fs.readFileSync(this.lockPath(), "utf8")) === process.pid) {
          fs.unlinkSync(this.lockPath());
        }
      } catch {
        /* already gone */
      }
      this.locked = false;
    }
  }

  // ---------- exact layer ----------

  private append(event: Sexp): void {
    const line = print(event) + "\n";
    if (this.fsync) {
      if (this.fd === null) this.fd = fs.openSync(this.path, "a");
      fs.writeSync(this.fd, line);
      fs.fsyncSync(this.fd);
    } else {
      fs.appendFileSync(this.path, line);
    }
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
          provenance: provenance as ProvRef[], forgotten: false,
        });
        this.traces.set(id, { recallCount: 0, lastAccess: ts });
        break;
      }
      // Reconsolidation: the successor fact replaces the predecessor in
      // recall, the predecessor stays in the log forever, and a `supersedes`
      // link records the chain — belief history is auditable, not overwritten.
      case "revise": {
        const [oldId, newId, ts, text, provenance] = rest;
        this.episodes.set(newId, {
          id: newId, ts, content: text, text, kind: "fact",
          provenance: provenance as ProvRef[], forgotten: false,
        });
        this.traces.set(newId, { recallCount: 0, lastAccess: ts });
        const old = this.episodes.get(oldId);
        if (old) old.forgotten = true;
        this.links.push({ src: newId, rel: "supersedes", dst: oldId });
        this.degree.set(newId, (this.degree.get(newId) ?? 0) + 1);
        this.degree.set(oldId, (this.degree.get(oldId) ?? 0) + 1);
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
        this.degree.set(src, (this.degree.get(src) ?? 0) + 1);
        this.degree.set(dst, (this.degree.get(dst) ?? 0) + 1);
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
      // Explicit use: the agent said "this one mattered." Weighted heavier
      // than passive surfacing (recall reinforces lexical traps too) so the
      // feedback signal can actually separate the used from the surfaced.
      case "touched": {
        const [id, ts] = rest;
        const t = this.traces.get(id);
        if (t) {
          t.recallCount += TOUCH_WEIGHT;
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
      case "extracted": {
        const [id] = rest;
        this.extracted.add(id);
        break;
      }
      // Snapshot-only event: compact trace state written during rollover.
      case "trace": {
        const [id, recallCount, lastAccess] = rest;
        const t = this.traces.get(id);
        if (t) {
          t.recallCount = recallCount;
          t.lastAccess = lastAccess;
        }
        break;
      }
    }
  }

  // ---------- log segmentation ----------
  //
  // When the active log outgrows maxLogBytes, archive it intact (the exact
  // layer never loses history) and start a fresh active file seeded with a
  // snapshot: live episodes/facts/entities, compact trace state, links, and
  // extraction markers. Loads then read snapshot + tail, not all of history.

  private maybeRollover(): void {
    if (fs.statSync(this.path).size <= this.maxLogBytes) return;
    const archive = `${this.path}.${Date.now()}.archive`;
    fs.renameSync(this.path, archive);

    const lines: string[] = [];
    // Retain live memories PLUS the belief chains behind them: a tombstoned
    // predecessor reachable via supersedes links from a live fact must survive
    // the snapshot (with its tombstone), or rollover would silently destroy
    // the revise paper trail — (history) would truncate and (sources oldId)
    // would throw, making audit answers depend on when rollover fired.
    const retained = new Map(
      [...this.episodes.values()].filter((e) => !e.forgotten).map((e) => [e.id, e]),
    );
    let grew = true;
    while (grew) {
      grew = false;
      for (const l of this.links) {
        if (l.rel === "supersedes" && retained.has(l.src) && !retained.has(l.dst)) {
          const ep = this.episodes.get(l.dst);
          if (ep) {
            retained.set(ep.id, ep);
            grew = true;
          }
        }
      }
    }
    const live = [...retained.values()].sort((a, b) => a.ts - b.ts);
    for (const e of live) {
      if (e.kind === "fact") lines.push(print([sym("fact"), e.id, e.ts, e.text, e.provenance ?? []]));
      else if (e.kind === "entity") {
        const kindName = e.text.slice(e.text.lastIndexOf("(") + 1, -1);
        lines.push(print([sym("entity"), e.id, e.ts, e.content, sym(kindName)]));
      } else lines.push(print([sym("episode"), e.id, e.ts, e.content]));
    }
    const liveIds = new Set(live.map((e) => e.id));
    // Re-tombstone retained-but-forgotten chain predecessors.
    for (const e of live) {
      if (e.forgotten) lines.push(print([sym("forget"), e.id, Date.now()]));
    }
    for (const [id, t] of this.traces) {
      if (liveIds.has(id) && t.recallCount > 0)
        lines.push(print([sym("trace"), id, t.recallCount, t.lastAccess]));
    }
    for (const id of this.extracted) {
      if (liveIds.has(id)) lines.push(print([sym("extracted"), id, Date.now()]));
    }
    for (const l of this.links) {
      if (liveIds.has(l.src) && liveIds.has(l.dst))
        lines.push(print([sym("link"), l.src, sym(l.rel), l.dst]));
    }
    fs.writeFileSync(this.path, lines.join("\n") + "\n");

    // Refold from the snapshot so in-memory state matches the new active file
    // (dropped tombstones, pruned dangling links).
    this.episodes.clear();
    this.traces.clear();
    this.links = [];
    this.degree.clear();
    this.entityIds.clear();
    this.extracted.clear();
    this.loadAndFold();
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
    this.cacheDirty = false;
  }

  private cacheDirty = false;
  private cacheTimer: NodeJS.Timeout | null = null;

  // The cache is derived state: losing it costs a re-embed, never data.
  // Debounce writes so bulk ingest is O(n), not O(n²) JSON serialization.
  private scheduleVecCacheSave(): void {
    this.cacheDirty = true;
    if (this.cacheTimer) return;
    this.cacheTimer = setTimeout(() => {
      this.cacheTimer = null;
      if (this.cacheDirty) this.saveVecCache();
    }, 250);
    this.cacheTimer.unref?.();
  }

  /** Force-write the vector cache now (e.g. before process exit). */
  flush(): void {
    if (this.cacheDirty) this.saveVecCache();
  }

  private async ensureVecs(): Promise<void> {
    for (const ep of this.episodes.values()) {
      if (!this.vecs.has(ep.id)) this.vecs.set(ep.id, await this.embedder.embed(ep.text));
    }
  }

  // ---------- ANN index (derived, disposable) ----------

  private liveCount(): number {
    let n = 0;
    for (const e of this.episodes.values()) if (!e.forgotten) n++;
    return n;
  }

  private ensureIndex(): void {
    if (this.index || this.liveCount() < ANN_THRESHOLD) return;
    const idx = new HNSW();
    for (const ep of this.episodes.values()) {
      if (!ep.forgotten) idx.insert(ep.id, this.vecs.get(ep.id)!);
    }
    this.index = idx;
  }

  private indexInsert(id: string): void {
    this.index?.insert(id, this.vecs.get(id)!);
  }

  // ---------- API ----------

  async remember(content: Sexp, ts = Date.now()): Promise<string> {
    const id = randomUUID().slice(0, 8);
    this.append([sym("episode"), id, ts, content]);
    this.vecs.set(id, await this.embedder.embed(this.episodes.get(id)!.text));
    this.indexInsert(id);
    this.scheduleVecCacheSave();
    return id;
  }

  link(src: string, rel: string, dst: string): void {
    this.append([sym("link"), src, sym(rel), dst]);
  }

  // Assert a fact directly — the mechanism for memories ABOUT external
  // systems of record: the claim lives here, the exact value stays there,
  // and provenance carries the pointer for dereferencing.
  async assertFact(text: string, provenance: ProvRef[] = [], ts = Date.now()): Promise<string> {
    if (typeof text !== "string" || !text.trim()) throw new Error("fact text must be a non-empty string");
    if (!Array.isArray(provenance)) throw new Error("provenance must be a list of refs");
    const id = randomUUID().slice(0, 8);
    this.append([sym("fact"), id, ts, text, provenance]);
    this.vecs.set(id, await this.embedder.embed(text));
    this.indexInsert(id);
    this.scheduleVecCacheSave();
    return id;
  }

  // Supersede a belief. The old fact is tombstoned (never deleted), the new
  // one takes its place in recall, and (history id) walks the chain.
  async revise(oldId: string, text: string, provenance: ProvRef[] = [], ts = Date.now()): Promise<string> {
    if (typeof text !== "string" || !text.trim()) throw new Error("revised text must be a non-empty string");
    if (!Array.isArray(provenance)) throw new Error("provenance must be a list of refs");
    const old = this.episodes.get(oldId);
    if (!old) throw new Error(`no memory ${oldId}`);
    if (old.kind !== "fact" && old.kind !== "episode") {
      throw new Error(`cannot revise a ${old.kind}`);
    }
    // Superseded facts must not be revised — that would fork the chain into
    // two live contradictory heads. (Merely decayed/forgotten facts MAY be
    // revised: a faded belief can legitimately be revived by new evidence.)
    if (this.links.some((l) => l.rel === "supersedes" && l.dst === oldId)) {
      throw new Error(`${oldId} is already superseded; revise the chain head (see (history ...))`);
    }
    const id = randomUUID().slice(0, 8);
    this.append([sym("revise"), oldId, id, ts, text, provenance]);
    this.vecs.set(id, await this.embedder.embed(text));
    this.indexInsert(id);
    this.scheduleVecCacheSave();
    return id;
  }

  /** External references in a memory's provenance — structured entries that
   *  point OUTSIDE the store (episode-refs are internal and excluded). */
  sources(id: string): ProvRef[] {
    const ep = this.episodes.get(id);
    if (!ep) throw new Error(`no memory ${id}`);
    return (ep.provenance ?? []).filter((p: ProvRef) => {
      if (!Array.isArray(p)) return false;
      const head = p[0] instanceof Sym ? p[0].name : p[0];
      return head !== "episode";
    });
  }

  /** The belief chain for a fact, newest first, following supersedes links. */
  history(id: string): Episode[] {
    const chain: Episode[] = [];
    let cur: string | undefined = id;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const ep = this.episodes.get(cur);
      if (!ep) break;
      chain.push(ep);
      cur = this.links.find((l) => l.src === cur && l.rel === "supersedes")?.dst;
    }
    return chain;
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
    this.indexInsert(id);
    this.scheduleVecCacheSave();
    return id;
  }

  // Observation is a write: recalling a memory reinforces it. The recall
  // events land in the same append-only log as everything else.
  //
  // score = similarity × recency × strength × importance, where importance
  // grows with link degree — well-connected memories are load-bearing.
  // Small stores scan exactly; past ANN_THRESHOLD an HNSW index preselects
  // candidates (oversampled, since rescoring can reorder them).
  async recall(query: string, n = 5, now = Date.now()): Promise<Recalled[]> {
    const qe = await this.embedder.embed(query);
    this.ensureIndex();

    const score = (ep: Episode, similarity: number): Recalled => {
      const t = this.traces.get(ep.id)!;
      const ageHours = Math.max(0, now - t.lastAccess) / 3_600_000;
      const recency = Math.pow(0.5, ageHours / HALF_LIFE_HOURS);
      const strength = 1 + REINFORCE_WEIGHT * Math.log1p(t.recallCount);
      const importance = 1 + DEGREE_WEIGHT * Math.log1p(this.degree.get(ep.id) ?? 0);
      // Similarity is squared: relevance must dominate, with usage signals
      // (recency/strength/importance) breaking near-ties rather than letting
      // a much-used memory hijack an unrelated query. Linear similarity with
      // linear strength measurably LOST to similarity-only retrieval on the
      // eval harness (hot memories drowned quiet correct answers); this
      // calibration wins. See scripts/eval.ts and docs/eval.md.
      return {
        id: ep.id,
        score: similarity * similarity * recency * strength * importance,
        similarity,
        episode: ep,
      };
    };

    let scored: Recalled[];
    if (this.index) {
      scored = this.index
        .search(qe, n * ANN_OVERSAMPLE, undefined, (id) => !this.episodes.get(id)!.forgotten)
        .map((c) => score(this.episodes.get(c.id)!, c.sim));
    } else {
      scored = [];
      for (const ep of this.episodes.values()) {
        if (ep.forgotten) continue;
        scored.push(score(ep, cosine(qe, this.vecs.get(ep.id)!)));
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, n).filter((r) => r.similarity > 0);
    for (const r of top) this.append([sym("recalled"), r.id, now]);
    return top;
  }

  // Explicit reinforcement: the agent signals "this memory was actually
  // useful" — a stronger, cleaner signal than surfacing (recall reinforces
  // whatever it returned, lexical traps included). Same event as a recall;
  // usage is usage.
  touch(id: string, now = Date.now()): void {
    const ep = this.episodes.get(id);
    if (!ep) throw new Error(`no memory ${id}`);
    this.append([sym("touched"), id, now]);
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
      this.indexInsert(factId);
      for (const id of ids) this.append([sym("forget"), id, now]);
      factIds.push(factId);
    }
    if (factIds.length) this.scheduleVecCacheSave();
    return factIds;
  }

  // Archive compaction: convert archived log segments (text S-expressions)
  // to Parquet so the cold tail joins the composable stack — DuckDB, Spark,
  // anything that reads Parquet can query pentagram's history in place.
  // Lossless: typed columns for the common queries, plus a `raw` column
  // holding each original S-expression line. Requires the optional
  // @dsnp/parquetjs dependency.
  async compactArchives(opts: { remove?: boolean } = {}): Promise<string[]> {
    const { remove = true } = opts;
    const dir = nodePath.dirname(nodePath.resolve(this.path));
    const base = nodePath.basename(this.path);
    const archives = fs.readdirSync(dir)
      .filter((f) => f.startsWith(base + ".") && f.endsWith(".archive"))
      .map((f) => nodePath.join(dir, f));
    if (!archives.length) return [];

    let pw: any;
    try {
      pw = await import("hyparquet-writer");
    } catch {
      throw new Error("archive compaction needs the optional dependency hyparquet-writer");
    }

    interface Row {
      event: string;
      id: string | null;
      ts: number | null;
      text: string | null;
      src: string | null;
      rel: string | null;
      dst: string | null;
      raw: string;
    }

    const written: string[] = [];
    for (const archive of archives) {
      const out = archive.replace(/\.archive$/, ".parquet");
      const rows: Row[] = [];
      const push = (r: Partial<Row> & { event: string; raw: string }) =>
        rows.push({ id: null, ts: null, text: null, src: null, rel: null, dst: null, ...r });

      for (const event of readAll(fs.readFileSync(archive, "utf8"))) {
        const [tag, ...rest] = event as [Sym, ...Sexp[]];
        const raw = print(event);
        switch (tag.name) {
          case "episode":
          case "fact":
            push({
              event: tag.name, id: rest[0], ts: rest[1],
              text: typeof rest[2] === "string" ? rest[2] : print(rest[2]), raw,
            });
            break;
          case "entity":
            push({ event: "entity", id: rest[0], ts: rest[1], text: String(rest[2]), raw });
            break;
          case "link":
            push({
              event: "link", src: rest[0],
              rel: rest[1] instanceof Sym ? rest[1].name : String(rest[1]), dst: rest[2], raw,
            });
            break;
          case "revise":
            // id = the fact this event CREATED (successor); src = superseded.
            push({
              event: "revise", id: rest[1], src: rest[0], ts: rest[2],
              text: typeof rest[3] === "string" ? rest[3] : print(rest[3]), raw,
            });
            break;
          default: // recalled, forget, extracted, trace
            push({ event: tag.name, id: rest[0], ts: typeof rest[1] === "number" ? rest[1] : null, raw });
        }
      }

      const col = (name: keyof Row, type: string) => ({
        name, type, nullable: true, data: rows.map((r) => r[name]),
      });
      pw.parquetWriteFile({
        filename: out,
        columnData: [
          col("event", "STRING"), col("id", "STRING"), col("ts", "DOUBLE"),
          col("text", "STRING"), col("src", "STRING"), col("rel", "STRING"),
          col("dst", "STRING"), col("raw", "STRING"),
        ],
      });
      if (remove) fs.unlinkSync(archive);
      written.push(out);
    }
    return written;
  }

  // Entity extraction, batch-style (like consolidation): process live episodes
  // that have not been extracted yet, creating entity nodes and `mentions`
  // links. Each processed episode gets an `extracted` marker event so passes
  // are incremental and idempotent. Capped per pass — extraction may call an
  // LLM per episode.
  async extractEntities(opts: ExtractOptions = {}): Promise<Map<string, string[]>> {
    const { extractor = this.extractor, limit = EXTRACT_BATCH, now = Date.now() } = opts;
    if (!extractor) throw new Error("no extractor configured");
    const results = new Map<string, string[]>();
    const pending = [...this.episodes.values()]
      .filter((e) => !e.forgotten && e.kind === "episode" && !this.extracted.has(e.id))
      .sort((a, b) => a.ts - b.ts)
      .slice(0, limit);

    for (const ep of pending) {
      const found = await extractor(ep.text);
      const entIds: string[] = [];
      for (const { name, kind } of found) {
        const eid = await this.entity(name, kind, now);
        if (!this.links.some((l) => l.src === ep.id && l.rel === "mentions" && l.dst === eid)) {
          this.link(ep.id, "mentions", eid);
        }
        entIds.push(eid);
      }
      this.append([sym("extracted"), ep.id, now]);
      results.set(ep.id, entIds);
    }
    return results;
  }

  // The sleep cycle: decay → extract → consolidate, in that order (extraction
  // before consolidation so entities are mined from episodes before those
  // episodes are compressed into facts).
  async sleepCycle(now = Date.now()): Promise<{ forgotten: number; extracted: number; facts: number }> {
    const forgotten = this.decay(now).length;
    let extracted = 0;
    if (this.extractor) {
      extracted = (await this.extractEntities({ now })).size;
    }
    const facts = (await this.consolidate({ now })).length;
    return { forgotten, extracted, facts };
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
      recall_index: this.index ? "hnsw" : "scan",
    };
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
