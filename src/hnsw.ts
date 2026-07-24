// HNSW (Hierarchical Navigable Small World) approximate nearest-neighbor
// index, pure TypeScript, zero dependencies. Malkov & Yashunin (2016).
//
// The index is derived state like everything else in the associative layer:
// built from the vectors at open, never persisted, disposable. Deletion is
// handled the pentagram way — tombstoned ids are filtered at search time
// (with oversampling), matching the store's forget semantics.
//
// Vectors are L2-normalized upstream, so similarity is a dot product.

import { cosine } from "./embed.js";

interface Node {
  id: string;
  vec: Float32Array;
  // neighbors[l] = ids of neighbors at layer l (0 = base layer)
  neighbors: string[][];
}

export class HNSW {
  private nodes = new Map<string, Node>();
  private entry: string | null = null;
  private maxLevel = -1;
  private readonly ml: number;

  constructor(
    private readonly M = 16, // max neighbors per layer (2M at base)
    private readonly efConstruction = 100,
  ) {
    this.ml = 1 / Math.log(M);
  }

  get size(): number {
    return this.nodes.size;
  }

  insert(id: string, vec: Float32Array, rand = Math.random): void {
    if (this.nodes.has(id)) return;
    const level = Math.floor(-Math.log(Math.max(rand(), 1e-12)) * this.ml);
    const node: Node = { id, vec, neighbors: Array.from({ length: level + 1 }, () => []) };
    this.nodes.set(id, node);

    if (this.entry === null) {
      this.entry = id;
      this.maxLevel = level;
      return;
    }

    // Greedy descent through layers above the node's level.
    let ep = [this.entry];
    for (let l = this.maxLevel; l > level; l--) {
      ep = this.searchLayer(vec, ep, 1, l).map((c) => c.id);
    }

    // Insert with efConstruction search on each layer the node occupies.
    for (let l = Math.min(level, this.maxLevel); l >= 0; l--) {
      const found = this.searchLayer(vec, ep, this.efConstruction, l);
      const maxConn = l === 0 ? this.M * 2 : this.M;
      const selected = found.slice(0, maxConn);
      node.neighbors[l] = selected.map((c) => c.id);
      for (const c of selected) {
        const other = this.nodes.get(c.id)!;
        other.neighbors[l].push(id);
        if (other.neighbors[l].length > maxConn) {
          // Prune to the closest maxConn neighbors.
          other.neighbors[l] = other.neighbors[l]
            .map((nid) => ({ nid, sim: cosine(other.vec, this.nodes.get(nid)!.vec) }))
            .sort((a, b) => b.sim - a.sim)
            .slice(0, maxConn)
            .map((x) => x.nid);
        }
      }
      ep = found.map((c) => c.id);
    }

    if (level > this.maxLevel) {
      this.maxLevel = level;
      this.entry = id;
    }
  }

  /** Top-k ids by similarity, filtered (e.g. to skip tombstoned memories). */
  search(
    vec: Float32Array,
    k: number,
    ef = Math.max(128, k * 2),
    keep: (id: string) => boolean = () => true,
  ): { id: string; sim: number }[] {
    if (this.entry === null) return [];
    let ep = [this.entry];
    for (let l = this.maxLevel; l > 0; l--) {
      ep = this.searchLayer(vec, ep, 1, l).map((c) => c.id);
    }
    return this.searchLayer(vec, ep, Math.max(ef, k), 0)
      .filter((c) => keep(c.id))
      .slice(0, k);
  }

  // Best-first search within one layer. Returns candidates sorted by
  // similarity descending, at most ef of them.
  private searchLayer(
    vec: Float32Array,
    entryPoints: string[],
    ef: number,
    layer: number,
  ): { id: string; sim: number }[] {
    const visited = new Set<string>(entryPoints);
    // candidates: to-explore, best-first; results: best ef found so far.
    const candidates: { id: string; sim: number }[] = [];
    const results: { id: string; sim: number }[] = [];

    for (const id of entryPoints) {
      const sim = cosine(vec, this.nodes.get(id)!.vec);
      candidates.push({ id, sim });
      results.push({ id, sim });
    }
    candidates.sort((a, b) => b.sim - a.sim);
    results.sort((a, b) => b.sim - a.sim);

    while (candidates.length) {
      const current = candidates.shift()!;
      const worst = results[results.length - 1];
      if (results.length >= ef && current.sim < worst.sim) break;

      const node = this.nodes.get(current.id)!;
      const neighbors = node.neighbors[layer] ?? [];
      for (const nid of neighbors) {
        if (visited.has(nid)) continue;
        visited.add(nid);
        const sim = cosine(vec, this.nodes.get(nid)!.vec);
        if (results.length < ef || sim > results[results.length - 1].sim) {
          insertSorted(candidates, { id: nid, sim });
          insertSorted(results, { id: nid, sim });
          if (results.length > ef) results.pop();
        }
      }
    }
    return results;
  }
}

// Insert into a similarity-descending array, keeping it sorted (binary search).
function insertSorted(arr: { id: string; sim: number }[], item: { id: string; sim: number }): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].sim > item.sim) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, item);
}
