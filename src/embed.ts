// Pluggable embedders. Two implementations:
//
//   hashEmbedder     — hashed character trigrams + word features. Deterministic,
//                      offline, zero dependencies. Not semantic; the fallback.
//   semanticEmbedder — all-MiniLM-L6-v2 running locally via transformers.js
//                      (optional dependency; the model downloads on first use,
//                      ~25 MB, then caches). Real semantic similarity, no API key.
//
// The store never knows which one it has; embeddings are derived state, so
// switching embedders just re-derives the associative layer.

export interface Embedder {
  /** Identifies embedder+dims; tags the sidecar vector cache. */
  name: string;
  dim: number;
  embed(text: string): Promise<Float32Array>;
}

// ---------- hash embedder (default, zero-dep) ----------

const HASH_DIM = 256;

export const hashEmbedder: Embedder = {
  name: `hash-trigram-${HASH_DIM}`,
  dim: HASH_DIM,
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(HASH_DIM);
    const s = " " + text.toLowerCase().replace(/\s+/g, " ").trim() + " ";
    for (let i = 0; i + 3 <= s.length; i++) {
      v[fnv(s.slice(i, i + 3)) % HASH_DIM] += 1;
    }
    for (const word of s.trim().split(" ")) {
      if (word) v[fnv("w:" + word) % HASH_DIM] += 2;
    }
    return normalize(v);
  },
};

// ---------- semantic embedder (optional dependency) ----------

let pipe: any = null;

export const semanticEmbedder: Embedder = {
  name: "minilm-l6-v2-384",
  dim: 384,
  async embed(text: string): Promise<Float32Array> {
    if (!pipe) {
      const transformers: any = await import("@huggingface/transformers");
      pipe = await transformers.pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2",
        { dtype: "q8" },
      );
    }
    const out = await pipe(text, { pooling: "mean", normalize: true });
    return new Float32Array(out.data);
  },
};

/** semanticEmbedder if transformers.js is installed, else hashEmbedder. */
export async function bestEmbedder(): Promise<Embedder> {
  try {
    await import("@huggingface/transformers");
    return semanticEmbedder;
  } catch {
    return hashEmbedder;
  }
}

/** Release the ONNX session. Call before process exit — onnxruntime-node
 *  aborts (SIGABRT) if its worker threads are torn down mid-lock. */
export async function disposeEmbedder(): Promise<void> {
  if (pipe) {
    await pipe.dispose();
    pipe = null;
  }
}

// ---------- shared ----------

// Vectors are normalized, so cosine similarity is a dot product.
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
