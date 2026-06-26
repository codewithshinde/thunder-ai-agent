export interface EmbeddingProvider {
  readonly id: string;
  embed(texts: string[]): Promise<number[][]>;
}

export class NoOpEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'noop';

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => []);
  }
}

export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'hash-fallback';

  /** Deterministic bag-of-words hash embedding for local semantic-ish search without an API. */
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => hashEmbed(text, 64));
  }
}

function hashEmbed(text: string, dims: number): number[] {
  const vec = new Array(dims).fill(0);
  const tokens = text.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  for (const token of tokens) {
    let h = 0;
    for (let i = 0; i < token.length; i++) {
      h = (h * 31 + token.charCodeAt(i)) >>> 0;
    }
    vec[h % dims] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
