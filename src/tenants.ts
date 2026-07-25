// Multi-tenant isolation, the file-backend way: one fully separate store per
// tenant — own log, own lock, own vector cache, own evaluation environment.
// Isolation is structural, not policy: a tenant's builtins close over that
// tenant's store and cannot name any other. The security boundary is the
// tenant-name validator, which is what keeps names from being paths.

import * as fs from "node:fs";
import * as nodePath from "node:path";
import { Store, StoreOptions } from "./store.js";
import { Embedder, hashEmbedder } from "./embed.js";
import { Summarizer, extractiveSummarizer } from "./summarize.js";

const TENANT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validTenant(name: string): boolean {
  return TENANT_RE.test(name);
}

export class Tenants {
  private stores = new Map<string, Promise<Store>>();

  constructor(
    private rootDir: string,
    private embedder: Embedder = hashEmbedder,
    private summarizer: Summarizer = extractiveSummarizer,
    private opts: StoreOptions = {},
  ) {}

  /** Open (or return the cached) isolated store for a tenant. */
  get(name: string): Promise<Store> {
    if (!validTenant(name)) {
      throw new Error(
        `invalid tenant name ${JSON.stringify(name)}: must match ${TENANT_RE}`,
      );
    }
    let p = this.stores.get(name);
    if (!p) {
      fs.mkdirSync(this.rootDir, { recursive: true });
      p = Store.open(
        nodePath.join(this.rootDir, `${name}.pgram`),
        this.embedder,
        this.summarizer,
        this.opts,
      );
      this.stores.set(name, p);
    }
    return p;
  }

  list(): string[] {
    return [...this.stores.keys()];
  }

  async close(): Promise<void> {
    for (const p of this.stores.values()) {
      try {
        (await p).close();
      } catch {
        /* already closed or failed open */
      }
    }
    this.stores.clear();
  }
}
