/**
 * Provider-agnostic embedding generation.
 *
 * Auto-detects the best available embedding provider (priority order):
 *   1. OPENAI_API_KEY      → text-embedding-3-small  (512 dims)
 *   2. GOOGLE_AI_API_KEY   → text-embedding-004       (768 dims)
 *   3. OLLAMA_HOST         → nomic-embed-text         (768 dims, local/free)
 *   4. Ollama auto-detect  → tries localhost:11434    (no config needed)
 *   5. Built-in TF-IDF     → pure JS, zero deps, zero API calls
 *
 * Override with: EMBEDDING_PROVIDER=openai|google|ollama|tfidf
 * Override Ollama model with: OLLAMA_EMBED_MODEL=nomic-embed-text
 *
 * Note: vectors from different providers are NOT interchangeable.
 * Callers (SkillLoader, memory.js) tag stored vectors with the provider name
 * and skip vectors that don't match the current provider.
 */

import { embed } from "ai";

let _ollamaAutoDetected = null; // null = untested, true/false = tested

/**
 * Probe localhost:11434 for a running Ollama instance (one-time check, cached).
 */
async function _probeOllama() {
  if (_ollamaAutoDetected !== null) return _ollamaAutoDetected;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch("http://localhost:11434/api/tags", { signal: ctrl.signal });
    clearTimeout(timer);
    _ollamaAutoDetected = res.ok;
  } catch {
    _ollamaAutoDetected = false;
  }
  return _ollamaAutoDetected;
}

/**
 * Returns the currently active embedding provider name, or null if none available.
 * Sync version — returns "ollama-auto" when auto-detect is pending (caller must handle).
 */
export function getEmbeddingProvider() {
  const override = process.env.EMBEDDING_PROVIDER?.toLowerCase();

  if (override) {
    if (override === "openai"  && process.env.OPENAI_API_KEY)    return "openai";
    if (override === "google"  && process.env.GOOGLE_AI_API_KEY) return "google";
    if (override === "ollama")                                    return "ollama";
    if (override === "tfidf")                                     return "tfidf";
    return null;
  }

  // Auto-detect in priority order
  if (process.env.OPENAI_API_KEY)    return "openai";
  if (process.env.GOOGLE_AI_API_KEY) return "google";
  if (process.env.OLLAMA_HOST)       return "ollama";
  // Ollama auto-detect result (set after first generateEmbedding call)
  if (_ollamaAutoDetected === true)  return "ollama";
  // Always available — built-in TF-IDF as last resort
  return "tfidf";
}

/**
 * Async version of getEmbeddingProvider — probes Ollama if not yet tested.
 */
export async function getEmbeddingProviderAsync() {
  const override = process.env.EMBEDDING_PROVIDER?.toLowerCase();

  if (override) {
    if (override === "openai"  && process.env.OPENAI_API_KEY)    return "openai";
    if (override === "google"  && process.env.GOOGLE_AI_API_KEY) return "google";
    if (override === "ollama")                                    return "ollama";
    if (override === "tfidf")                                     return "tfidf";
    return "tfidf";
  }

  if (process.env.OPENAI_API_KEY)    return "openai";
  if (process.env.GOOGLE_AI_API_KEY) return "google";
  if (process.env.OLLAMA_HOST)       return "ollama";

  // Auto-probe Ollama on localhost
  if (_ollamaAutoDetected === null) {
    const found = await _probeOllama();
    if (found) {
      console.log("[Embeddings] Auto-detected Ollama at localhost:11434");
      return "ollama";
    }
  } else if (_ollamaAutoDetected) {
    return "ollama";
  }

  return "tfidf";
}

// ── Built-in TF-IDF ──────────────────────────────────────────────────────────
// Pure JS, zero deps, zero API calls. Produces sparse vectors for cosine similarity.
// Quality is lower than neural embeddings but far better than naive keyword matching.

const _idfCache = new Map();   // word → idf score
const _vocabList = [];         // ordered vocabulary for consistent vector indices
const _vocabIndex = new Map(); // word → index in _vocabList

/**
 * Tokenize text into lowercase word stems (simple).
 */
function _tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1);
}

/**
 * Build/update IDF table from a corpus of documents.
 * Call once with all skill texts at startup.
 * @param {string[]} docs - array of document texts
 */
export function buildTfidfVocab(docs) {
  _idfCache.clear();
  _vocabList.length = 0;
  _vocabIndex.clear();

  const N = docs.length;
  if (N === 0) return;

  // Count document frequency for each word
  const df = new Map();
  for (const doc of docs) {
    const unique = new Set(_tokenize(doc));
    for (const w of unique) {
      df.set(w, (df.get(w) || 0) + 1);
    }
  }

  // Compute IDF and build vocabulary (filter rare/ubiquitous words)
  let idx = 0;
  for (const [word, count] of df) {
    if (count < 1 || count === N) continue; // skip words in all/no docs
    const idf = Math.log((N + 1) / (count + 1)) + 1; // smoothed IDF
    _idfCache.set(word, idf);
    _vocabList.push(word);
    _vocabIndex.set(word, idx++);
  }
}

/**
 * Generate a TF-IDF vector for a text. Returns a sparse Float32Array.
 * Must call buildTfidfVocab() first.
 */
export function tfidfEmbed(text) {
  if (_vocabList.length === 0) return null;

  const tokens = _tokenize(text);
  const tf = new Map();
  for (const t of tokens) {
    if (_vocabIndex.has(t)) tf.set(t, (tf.get(t) || 0) + 1);
  }

  const vec = new Float32Array(_vocabList.length);
  let norm = 0;
  for (const [word, count] of tf) {
    const idx = _vocabIndex.get(word);
    const idf = _idfCache.get(word) || 0;
    const val = (1 + Math.log(count)) * idf; // log-normalized TF * IDF
    vec[idx] = val;
    norm += val * val;
  }

  // L2 normalize
  if (norm > 0) {
    const invNorm = 1 / Math.sqrt(norm);
    for (let i = 0; i < vec.length; i++) vec[i] *= invNorm;
  }

  return Array.from(vec);
}

/**
 * Generate a vector embedding for the given text using the best available provider.
 * Falls back through: API providers → local Ollama → built-in TF-IDF.
 *
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
export async function generateEmbedding(text) {
  const provider = await getEmbeddingProviderAsync();
  if (!provider) return null;

  // Built-in TF-IDF — no API call needed
  if (provider === "tfidf") {
    return tfidfEmbed(text);
  }

  try {
    let model;

    if (provider === "openai") {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
      model = openai.embedding("text-embedding-3-small", { dimensions: 512 });

    } else if (provider === "google") {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_AI_API_KEY });
      model = google.textEmbeddingModel("text-embedding-004");

    } else if (provider === "ollama") {
      const { ollama } = await import("ollama-ai-provider");
      const modelName = process.env.OLLAMA_EMBED_MODEL || "all-minilm";
      model = ollama.embedding(modelName);
    }

    if (!model) return null;

    const { embedding } = await embed({ model, value: text.slice(0, 8000) });
    return embedding;

  } catch {
    // API provider failed — fall back to TF-IDF
    const tfidfVec = tfidfEmbed(text);
    if (tfidfVec) return tfidfVec;
    return null;
  }
}
