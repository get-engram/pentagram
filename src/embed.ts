// Placeholder embedder: hashed character trigrams + word features, L2-normalized.
// Deterministic, offline, zero dependencies. Good enough to make similarity
// meaningful in tests; swap for a real embedding model behind the same signature.

export const DIM = 256;

export function embed(text: string): Float32Array {
  const v = new Float32Array(DIM);
  const s = " " + text.toLowerCase().replace(/\s+/g, " ").trim() + " ";
  for (let i = 0; i + 3 <= s.length; i++) {
    v[fnv(s.slice(i, i + 3)) % DIM] += 1;
  }
  for (const word of s.trim().split(" ")) {
    if (word) v[fnv("w:" + word) % DIM] += 2;
  }
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

// Vectors are normalized, so cosine similarity is a dot product.
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < DIM; i++) dot += a[i] * b[i];
  return dot;
}

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
