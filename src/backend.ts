// The storage seam. Store speaks LogBackend; where the bytes live is a
// backend concern. FileBackend is the local default (single file + sidecars,
// pid lockfile, fsync option). MemoryBackend backs tests and is the template
// for hosted backends (the Durable Object SQLite backend mirrors its shape).
//
// Only FileBackend may import node builtins — Store itself must stay
// portable to non-node runtimes (Cloudflare Workers).

import * as fs from "node:fs";
import * as nodePath from "node:path";

export interface LogBackend {
  /** Human-readable location for error messages. */
  describe(): string;
  exists(): boolean;
  /** Entire active log as text. */
  readText(): string;
  appendLine(line: string): void;
  sizeBytes(): number;
  /** Replace the active log wholesale (snapshot write, torn-line truncate). */
  replaceActive(content: string): void;
  /** Move the active log aside under `name`, leaving the active log empty. */
  archiveActive(name: string): void;
  /** Sidecar storage (vector cache, torn-write quarantine). */
  writeAux(name: string, content: string): void;
  readAux(name: string): string | null;
  /** Single-writer enforcement. lock() throws if another writer holds it. */
  lock(): void;
  unlock(): void;
  close(): void;

  // Archive access — optional capability (parquet compaction needs it plus
  // a real filesystem for the output; hosted backends typically omit it).
  listArchives?(): string[];
  readArchive?(name: string): string;
  removeArchive?(name: string): void;
  /** Filesystem path where compacted output for `name` should be written. */
  archiveOutPath?(name: string): string;
}

// ---------- file backend (local default) ----------

export class FileBackend implements LogBackend {
  private fd: number | null = null;
  private locked = false;

  constructor(
    readonly path: string,
    private fsync = false,
  ) {}

  describe(): string {
    return this.path;
  }
  exists(): boolean {
    return fs.existsSync(this.path);
  }
  readText(): string {
    return fs.readFileSync(this.path, "utf8");
  }
  appendLine(line: string): void {
    if (this.fsync) {
      if (this.fd === null) this.fd = fs.openSync(this.path, "a");
      fs.writeSync(this.fd, line);
      fs.fsyncSync(this.fd);
    } else {
      fs.appendFileSync(this.path, line);
    }
  }
  sizeBytes(): number {
    return fs.statSync(this.path).size;
  }
  replaceActive(content: string): void {
    fs.writeFileSync(this.path, content);
  }
  archiveActive(name: string): void {
    fs.renameSync(this.path, `${this.path}.${name}.archive`);
  }
  writeAux(name: string, content: string): void {
    fs.writeFileSync(`${this.path}.${name}`, content);
  }
  readAux(name: string): string | null {
    try {
      return fs.readFileSync(`${this.path}.${name}`, "utf8");
    } catch {
      return null;
    }
  }

  lock(): void {
    const lockPath = this.path + ".lock";
    const tryAcquire = () => fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    try {
      tryAcquire();
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      const holder = Number(fs.readFileSync(lockPath, "utf8"));
      // Our own pid counts as a live holder too: a second Store instance in
      // the same process is still a second writer.
      if (holder && (holder === process.pid || isAlive(holder))) {
        throw new Error(`memory log ${this.path} is locked by running process ${holder}`);
      }
      fs.unlinkSync(lockPath); // stale (dead holder): steal it
      tryAcquire();
    }
    this.locked = true;
  }
  unlock(): void {
    if (!this.locked) return;
    try {
      if (Number(fs.readFileSync(this.path + ".lock", "utf8")) === process.pid) {
        fs.unlinkSync(this.path + ".lock");
      }
    } catch {
      /* already gone */
    }
    this.locked = false;
  }
  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  listArchives(): string[] {
    const dir = nodePath.dirname(nodePath.resolve(this.path));
    const base = nodePath.basename(this.path);
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith(base + ".") && f.endsWith(".archive"))
      .map((f) => nodePath.join(dir, f));
  }
  readArchive(name: string): string {
    return fs.readFileSync(name, "utf8");
  }
  removeArchive(name: string): void {
    fs.unlinkSync(name);
  }
  archiveOutPath(name: string): string {
    return name.replace(/\.archive$/, ".parquet");
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

// ---------- memory backend (tests; template for hosted backends) ----------

export class MemoryBackend implements LogBackend {
  private active = "";
  private aux = new Map<string, string>();
  private archives = new Map<string, string>();
  private locked = false;

  describe(): string {
    return "<memory>";
  }
  exists(): boolean {
    return this.active.length > 0;
  }
  readText(): string {
    return this.active;
  }
  appendLine(line: string): void {
    this.active += line;
  }
  sizeBytes(): number {
    return this.active.length;
  }
  replaceActive(content: string): void {
    this.active = content;
  }
  archiveActive(name: string): void {
    this.archives.set(name, this.active);
    this.active = "";
  }
  writeAux(name: string, content: string): void {
    this.aux.set(name, content);
  }
  readAux(name: string): string | null {
    return this.aux.get(name) ?? null;
  }
  lock(): void {
    if (this.locked) throw new Error("memory log <memory> is locked by running process (this one)");
    this.locked = true;
  }
  unlock(): void {
    this.locked = false;
  }
  close(): void {}
}
