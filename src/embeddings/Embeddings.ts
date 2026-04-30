/**
 * Embeddings — provider-agnostic vector embedding for semantic search.
 *
 * Priority (first available wins):
 *   1. OpenAI   (vault OPENAI_API_KEY)     → text-embedding-3-small
 *   2. Google   (vault GOOGLE_AI_API_KEY)  → text-embedding-004
 *   3. Ollama   (localhost:11434 probed)   → all-minilm
 *   4. TF-IDF   (built-in, OPT-IN ONLY)    → keyword-weighted fallback
 *
 * If none of 1–3 are available, `provider()` returns `null` and
 * `generate()` returns `null`. Callers should treat a null result as
 * "no embedding available — fall back to non-embedding logic". TF-IDF
 * is not a silent default because it isn't really semantic matching
 * (it's weighted-keyword), and pretending otherwise leads to surprising
 * behaviour. Use TF-IDF by explicit opt-in only:
 *   - `EMBEDDING_PROVIDER=tfidf` env, or
 *   - `generate(text, "tfidf")` at the call site.
 *
 * IMPORTANT: vectors from different providers are NOT comparable.
 * Every stored embedding is tagged with `{ provider, dim }` so the
 * consumer (skill matcher, memory recall) can skip vectors that don't
 * match the currently-active provider.
 */

import { embed, embedMany, type EmbeddingModel } from "ai";

import type { ConfigManager } from "../config/ConfigManager.js";
import { createLogger } from "../util/logger.js";
import { TfIdfEmbedder } from "./TfIdf.js";

const log = createLogger("embeddings");

export type EmbeddingProvider = "openai" | "google" | "ollama" | "tfidf";

export interface EmbeddingResult {
  readonly provider: EmbeddingProvider;
  readonly vector: number[];
  readonly dim: number;
}

export interface EmbeddingBatchResult {
  readonly provider: EmbeddingProvider;
  readonly vectors: number[][];
  readonly dim: number;
}

const OLLAMA_DEFAULT_MODEL = "all-minilm";
const OLLAMA_PROBE_TIMEOUT_MS = 2_000;
const MAX_INPUT_CHARS = 8_000;

export class Embeddings {
  /** TF-IDF fallback. Exported so callers can `fit` its vocab on boot. */
  readonly tfidf = new TfIdfEmbedder();

  private ollamaProbed: boolean | null = null;
  private ollamaModelReady = false;

  constructor(private readonly cfg: ConfigManager) {}

  // ── Provider selection ────────────────────────────────────────────────

  /**
   * Pick the active provider, or `null` if no neural provider is
   * available. TF-IDF is only returned when explicitly opted in.
   * Async so we can probe Ollama on localhost the first time we're
   * called (cached after that).
   */
  async provider(): Promise<EmbeddingProvider | null> {
    const override = process.env["EMBEDDING_PROVIDER"]?.toLowerCase();
    if (override === "openai" && this.hasKey("OPENAI_API_KEY")) return "openai";
    if (override === "google" && this.hasKey("GOOGLE_AI_API_KEY")) return "google";
    if (override === "ollama") return "ollama";
    if (override === "tfidf")  return "tfidf";

    if (this.hasKey("OPENAI_API_KEY"))    return "openai";
    if (this.hasKey("GOOGLE_AI_API_KEY")) return "google";
    if (await this.probeOllama()) return "ollama";
    return null;
  }

  /** Synchronous best-guess — used where we can't await (e.g. JSON encoders). */
  providerSync(): EmbeddingProvider | null {
    const override = process.env["EMBEDDING_PROVIDER"]?.toLowerCase();
    if (override === "openai" && this.hasKey("OPENAI_API_KEY")) return "openai";
    if (override === "google" && this.hasKey("GOOGLE_AI_API_KEY")) return "google";
    if (override === "ollama")  return "ollama";
    if (override === "tfidf")   return "tfidf";
    if (this.hasKey("OPENAI_API_KEY"))    return "openai";
    if (this.hasKey("GOOGLE_AI_API_KEY")) return "google";
    if (this.ollamaProbed === true) return "ollama";
    return null;
  }

  /** Quick check: do we have any provider at all (neural or TF-IDF opt-in)? */
  async isAvailable(): Promise<boolean> {
    return (await this.provider()) !== null;
  }

  // ── Single + batch ────────────────────────────────────────────────────

  async generate(text: string, forceProvider?: EmbeddingProvider): Promise<EmbeddingResult | null> {
    const provider = forceProvider ?? await this.provider();
    if (provider === null) return null;
    const trimmed = (text ?? "").slice(0, MAX_INPUT_CHARS);

    if (provider === "tfidf") {
      const v = this.tfidf.embed(trimmed);
      return v ? { provider, vector: v, dim: v.length } : null;
    }

    try {
      const model = await this.buildProviderModel(provider);
      if (!model) return null;
      const { embedding } = await embed({ model, value: trimmed });
      return { provider, vector: embedding, dim: embedding.length };
    } catch (e) {
      // Neural provider failed mid-flight (429 / network / model missing).
      // Return null so the caller falls back to its non-embedding path
      // instead of silently swapping providers behind its back.
      log.warn({ provider, err: (e as Error).message }, "embedding provider failed — returning null");
      return null;
    }
  }

  async generateBatch(texts: readonly string[], forceProvider?: EmbeddingProvider): Promise<EmbeddingBatchResult | null> {
    if (texts.length === 0) return { provider: "tfidf", vectors: [], dim: 0 };
    const provider = forceProvider ?? await this.provider();
    if (provider === null) return null;
    const values = texts.map((t) => (t ?? "").slice(0, MAX_INPUT_CHARS));

    if (provider === "tfidf") {
      const vectors = values.map((v) => this.tfidf.embed(v) ?? []);
      const dim = vectors.find((v) => v.length > 0)?.length ?? 0;
      return { provider, vectors, dim };
    }

    try {
      const model = await this.buildProviderModel(provider);
      if (!model) return null;
      const { embeddings } = await embedMany({ model, values });
      return { provider, vectors: embeddings, dim: embeddings[0]?.length ?? 0 };
    } catch (e) {
      log.warn({ provider, err: (e as Error).message }, "batch embedding failed — returning null");
      return null;
    }
  }

  // ── Ollama readiness ──────────────────────────────────────────────────

  /**
   * Probe Ollama once on localhost. If reachable AND the embed model is
   * missing, auto-pull it (non-blocking best-effort). Call once at boot
   * so skill matching is live from the first task.
   */
  async ensureOllamaModel(): Promise<void> {
    const override = process.env["EMBEDDING_PROVIDER"]?.toLowerCase();
    if (override && override !== "ollama") return;
    if (this.hasKey("OPENAI_API_KEY") || this.hasKey("GOOGLE_AI_API_KEY")) return;

    const up = await this.probeOllama();
    if (!up) {
      log.info("ollama not detected — TF-IDF will handle embeddings");
      return;
    }
    const modelName = process.env["OLLAMA_EMBED_MODEL"] ?? OLLAMA_DEFAULT_MODEL;
    await this.pullOllamaModelIfMissing(modelName);
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private hasKey(key: string): boolean {
    return this.cfg.vault.isUnlocked() && this.cfg.vault.has(key);
  }

  private apiKey(key: string): string | undefined {
    const s = this.cfg.vault.get(key);
    return s?.reveal();
  }

  private async buildProviderModel(provider: EmbeddingProvider): Promise<EmbeddingModel | null> {
    if (provider === "openai") {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const key = this.apiKey("OPENAI_API_KEY");
      if (!key) return null;
      return createOpenAI({ apiKey: key }).embedding("text-embedding-3-small") as unknown as EmbeddingModel;
    }
    if (provider === "google") {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      const key = this.apiKey("GOOGLE_AI_API_KEY");
      if (!key) return null;
      return createGoogleGenerativeAI({ apiKey: key }).textEmbeddingModel("text-embedding-004") as unknown as EmbeddingModel;
    }
    if (provider === "ollama") {
      const { createOllama } = await import("ollama-ai-provider-v2");
      const baseURL = this.cfg.setting("OLLAMA_BASE_URL") ?? "http://localhost:11434";
      const modelName = process.env["OLLAMA_EMBED_MODEL"] ?? OLLAMA_DEFAULT_MODEL;
      return createOllama({ baseURL: `${baseURL}/api` }).textEmbeddingModel(modelName) as unknown as EmbeddingModel;
    }
    return null;
  }

  private async probeOllama(): Promise<boolean> {
    if (this.ollamaProbed !== null) return this.ollamaProbed;
    const baseUrl = process.env["OLLAMA_HOST"] ?? "http://localhost:11434";
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), OLLAMA_PROBE_TIMEOUT_MS);
      const res = await fetch(`${baseUrl}/api/tags`, { signal: ctrl.signal });
      clearTimeout(timer);
      this.ollamaProbed = res.ok;
    } catch {
      this.ollamaProbed = false;
    }
    return this.ollamaProbed;
  }

  private async pullOllamaModelIfMissing(modelName: string): Promise<void> {
    if (this.ollamaModelReady) return;
    const baseUrl = process.env["OLLAMA_HOST"] ?? "http://localhost:11434";
    try {
      const tags = await fetch(`${baseUrl}/api/tags`).then((r) => r.ok ? r.json() : null) as
        { models?: Array<{ name: string }> } | null;
      const list = tags?.models ?? [];
      const exists = list.some((m) => m.name === modelName || m.name.startsWith(`${modelName}:`));
      if (exists) {
        this.ollamaModelReady = true;
        log.info({ model: modelName }, "ollama embedding model ready");
        return;
      }
      log.info({ model: modelName }, "pulling ollama embedding model (one-time)");
      const res = await fetch(`${baseUrl}/api/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: modelName, stream: false }),
      });
      if (res.ok) {
        this.ollamaModelReady = true;
        log.info({ model: modelName }, "ollama embedding model pulled");
      } else {
        log.warn({ model: modelName, status: res.status }, "ollama model pull failed");
      }
    } catch (e) {
      log.warn({ err: (e as Error).message }, "ollama model check crashed");
    }
  }

}

// ── shared utility ─────────────────────────────────────────────────────

export function cosineSim(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
