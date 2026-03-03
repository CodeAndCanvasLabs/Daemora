/**
 * Provider-agnostic embedding generation.
 *
 * Auto-detects the best available embedding provider (priority order):
 *   1. OPENAI_API_KEY      → text-embedding-3-small  (512 dims)
 *   2. GOOGLE_AI_API_KEY   → text-embedding-004       (768 dims)
 *   3. OLLAMA_HOST         → nomic-embed-text         (768 dims, local/free)
 *   4. None                → returns null (callers fall back to keyword search)
 *
 * Override with: EMBEDDING_PROVIDER=openai|google|ollama
 * Override Ollama model with: OLLAMA_EMBED_MODEL=nomic-embed-text
 *
 * Note: vectors from different providers are NOT interchangeable.
 * Callers (SkillLoader, memory.js) tag stored vectors with the provider name
 * and skip vectors that don't match the current provider.
 */

import { embed } from "ai";

/**
 * Returns the currently active embedding provider name, or null if none available.
 */
export function getEmbeddingProvider() {
  const override = process.env.EMBEDDING_PROVIDER?.toLowerCase();

  if (override) {
    if (override === "openai"  && process.env.OPENAI_API_KEY)    return "openai";
    if (override === "google"  && process.env.GOOGLE_AI_API_KEY) return "google";
    if (override === "ollama")                                    return "ollama";
    return null;  // Override set but required key missing
  }

  // Auto-detect in priority order
  if (process.env.OPENAI_API_KEY)    return "openai";
  if (process.env.GOOGLE_AI_API_KEY) return "google";
  if (process.env.OLLAMA_HOST)       return "ollama";
  return null;
}

/**
 * Generate a vector embedding for the given text using the best available provider.
 * Returns null if no provider is configured - callers must fall back to keyword search.
 *
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
export async function generateEmbedding(text) {
  const provider = getEmbeddingProvider();
  if (!provider) return null;

  try {
    let model;

    if (provider === "openai") {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
      // 512 dims = 3x smaller than default 1536, minimal quality loss for recall tasks
      model = openai.embedding("text-embedding-3-small", { dimensions: 512 });

    } else if (provider === "google") {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_AI_API_KEY });
      model = google.textEmbeddingModel("text-embedding-004");  // 768 dims

    } else if (provider === "ollama") {
      const { ollama } = await import("ollama-ai-provider");
      const modelName = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
      model = ollama.embedding(modelName);  // typically 768 dims
    }

    if (!model) return null;

    const { embedding } = await embed({ model, value: text.slice(0, 8000) });
    return embedding;

  } catch {
    return null;
  }
}
