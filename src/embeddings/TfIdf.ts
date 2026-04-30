/**
 * TF-IDF embedder — pure JS, zero deps, always available.
 *
 * Builds a vocabulary from a corpus (call `fit` once at startup with
 * every document you'll embed — skills, memory entries, etc.), then
 * `embed(text)` returns a sparse L2-normalised vector with indices
 * into the vocabulary.
 *
 * Quality is lower than neural embeddings but dramatically better
 * than substring matching — synonyms still won't match, but frequent
 * generic words are down-weighted so the "signal" terms dominate the
 * cosine similarity.
 */

export class TfIdfEmbedder {
  private readonly vocab = new Map<string, number>();  // word → index
  private readonly vocabList: string[] = [];
  private readonly idf = new Map<string, number>();
  private fitted = false;

  get dim(): number {
    return this.vocabList.length;
  }

  get isFitted(): boolean {
    return this.fitted;
  }

  /** Build the vocabulary from a corpus. Calling `fit` again replaces it. */
  fit(docs: readonly string[]): void {
    this.vocab.clear();
    this.vocabList.length = 0;
    this.idf.clear();
    const N = docs.length;
    if (N === 0) {
      this.fitted = true;
      return;
    }

    // Document frequency per word.
    const df = new Map<string, number>();
    for (const doc of docs) {
      for (const w of new Set(tokenize(doc))) {
        df.set(w, (df.get(w) ?? 0) + 1);
      }
    }

    // Smoothed IDF. Drop words that appear in every document (no signal).
    let idx = 0;
    for (const [word, count] of df) {
      if (count < 1 || count === N) continue;
      this.idf.set(word, Math.log((N + 1) / (count + 1)) + 1);
      this.vocabList.push(word);
      this.vocab.set(word, idx++);
    }
    this.fitted = true;
  }

  /** Embed a single text into an L2-normalised vector. */
  embed(text: string): number[] | null {
    if (this.vocabList.length === 0) return null;
    const tf = new Map<string, number>();
    for (const t of tokenize(text)) {
      if (this.vocab.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    const vec = new Float32Array(this.vocabList.length);
    let norm = 0;
    for (const [word, count] of tf) {
      const i = this.vocab.get(word);
      if (i === undefined) continue;
      const idf = this.idf.get(word) ?? 0;
      const val = (1 + Math.log(count)) * idf;
      vec[i] = val;
      norm += val * val;
    }
    if (norm > 0) {
      const inv = 1 / Math.sqrt(norm);
      for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] ?? 0) * inv;
    }
    return Array.from(vec);
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}
