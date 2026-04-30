/**
 * Dynamic model discovery — fetches live model lists from provider APIs.
 *
 * Three discovery strategies:
 *   1. OpenAI-compatible: GET /v1/models (Bearer) — works for OpenAI,
 *      Groq, DeepSeek, Mistral, xAI, Together, Fireworks, Cerebras,
 *      OpenRouter, and any future provider using this standard.
 *   2. Anthropic: GET /v1/models (x-api-key + anthropic-version header)
 *   3. Google AI: GET /v1beta/models?key=... (API key as query param)
 *   4. Ollama: GET /api/tags (no auth, local)
 *
 * Results cached per-provider (120s TTL). Cache invalidates on vault
 * lock/unlock so key changes take effect immediately.
 */

import { existsSync } from "node:fs";
import { createLogger } from "../util/logger.js";
import { PROVIDERS_BY_ID } from "./providers.js";

const log = createLogger("models.discovery");

// Vertex SA discovery — opt-in via env. Mirrors ModelRouter.ts.
// When DAEMORA_VERTEX_SA_KEY_PATH points at a real SA JSON, vertex
// discovery probes each Gemini id with project scope so the Settings
// dropdown only shows what's actually accessible to this project.
// When the env vars are unset, this branch no-ops and discovery falls
// back to the Express (API-key) path.
const VERTEX_SA_PROJECT_ID = process.env["DAEMORA_VERTEX_PROJECT_ID"] ?? "";
const VERTEX_SA_KEY_PATH = process.env["DAEMORA_VERTEX_SA_KEY_PATH"] ?? "";

export interface DiscoveredModel {
  readonly id: string;
  readonly name: string;
  readonly ownedBy?: string;
  readonly created?: number;
}

interface CacheEntry { at: number; models: DiscoveredModel[] }

const CACHE_TTL = 120_000;
const TIMEOUT = 5_000;
const cache = new Map<string, CacheEntry>();

export function invalidateModelCache(): void {
  cache.clear();
  log.info("model discovery cache cleared");
}

export function invalidateProvider(providerId: string): void {
  cache.delete(providerId);
}

function cached(id: string): DiscoveredModel[] | null {
  const entry = cache.get(id);
  if (!entry || Date.now() - entry.at > CACHE_TTL) return null;
  return entry.models;
}

function store(id: string, models: DiscoveredModel[]): void {
  cache.set(id, { at: Date.now(), models });
}

// ── Generic OpenAI-compatible discovery ─────────────────────────

async function discoverOpenAICompat(
  providerId: string,
  baseUrl: string,
  apiKey: string,
  filterFn?: (model: { id: string; owned_by?: string }) => boolean,
): Promise<DiscoveredModel[]> {
  const hit = cached(providerId);
  if (hit) return hit;

  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`${providerId} /models ${res.status}`);
  const data = (await res.json()) as { data?: { id: string; owned_by?: string; created?: number }[] };

  let models = (data.data ?? []).map((m) => ({
    id: m.id,
    name: m.id,
    ...(m.owned_by ? { ownedBy: m.owned_by } : {}),
    ...(m.created ? { created: m.created } : {}),
  }));

  if (filterFn) models = models.filter((m) => filterFn(m));

  store(providerId, models);
  log.info({ provider: providerId, count: models.length }, "models discovered");
  return models;
}

// ── Provider-specific discovery ─────────────────────────────────

async function discoverAnthropic(apiKey: string): Promise<DiscoveredModel[]> {
  const hit = cached("anthropic");
  if (hit) return hit;

  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`Anthropic /models ${res.status}`);
  const data = (await res.json()) as { data: { id: string; display_name: string; created_at: string }[] };

  const models = data.data.map((m) => ({
    id: m.id,
    name: m.display_name || m.id,
    created: new Date(m.created_at).getTime(),
  }));

  store("anthropic", models);
  log.info({ count: models.length }, "Anthropic models discovered");
  return models;
}

async function discoverGoogle(apiKey: string): Promise<DiscoveredModel[]> {
  const hit = cached("google");
  if (hit) return hit;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`Google /models ${res.status}`);
  const data = (await res.json()) as {
    models: { name: string; displayName: string; supportedGenerationMethods: string[] }[];
  };

  const models = data.models
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => ({ id: m.name.replace("models/", ""), name: m.displayName || m.name }));

  store("google", models);
  log.info({ count: models.length }, "Google AI models discovered");
  return models;
}

/**
 * Vertex AI — discovers Gemini models accessible to the current project.
 *
 * Two-stage: first list the public catalog (no auth gating), then for
 * each Gemini id probe the project-scoped resource path on `global`
 * to filter to the ones THIS project actually has access to. The list
 * endpoint isn't project-scoped (404), so per-id GETs are the only
 * way to surface accurate availability — and previews like
 * gemini-3.1-pro-preview only exist on `global`.
 *
 * Auth modes:
 *   - SA JSON present (TEMP $300 credit setup) → bearer token, accurate
 *     project-scoped probes. Gives the user the real list.
 *   - Express API key only → catalog list, no per-id filter (faster,
 *     but may show models the project can't actually call).
 */
async function discoverVertex(apiKey: string): Promise<DiscoveredModel[]> {
  const hit = cached("vertex");
  if (hit) return hit;

  // 1. Pull the full public catalog. Same endpoint either way.
  const catalogUrl = `https://aiplatform.googleapis.com/v1beta1/publishers/google/models?key=${encodeURIComponent(apiKey)}&pageSize=200`;
  const res = await fetch(catalogUrl, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`Vertex /publishers/google/models ${res.status}`);
  const data = (await res.json()) as {
    publisherModels?: Array<{ name: string; launchStage?: string }>;
  };
  const candidates = (data.publisherModels ?? [])
    .map((m) => m.name.replace(/^publishers\/google\/models\//, ""))
    .filter((id) => /^gemini-/.test(id))
    .filter((id) => !/embedding|embed/.test(id));

  // 2. If the SA file is present, probe each candidate against
  //    project-scoped `global` to filter to actually-accessible models.
  //    A HEAD-style GET is enough (no body). Concurrent with a small
  //    cap so we don't slam the API.
  if (existsSync(VERTEX_SA_KEY_PATH)) {
    try {
      const { GoogleAuth } = await import("google-auth-library");
      const auth = new GoogleAuth({
        keyFile: VERTEX_SA_KEY_PATH,
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      });
      const client = await auth.getClient();
      const tokenInfo = await client.getAccessToken();
      const token = tokenInfo.token;
      if (!token) throw new Error("no SA token");
      const accessible: string[] = [];
      const concurrency = 8;
      for (let i = 0; i < candidates.length; i += concurrency) {
        const slice = candidates.slice(i, i + concurrency);
        const results = await Promise.all(slice.map(async (id) => {
          const url = `https://aiplatform.googleapis.com/v1/projects/${VERTEX_SA_PROJECT_ID}/locations/global/publishers/google/models/${id}`;
          const r = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(TIMEOUT),
          });
          return r.ok ? id : null;
        }));
        for (const r of results) if (r) accessible.push(r);
      }
      const models = accessible.map((id) => ({ id, name: id }));
      store("vertex", models);
      log.info({ count: models.length, total: candidates.length }, "Vertex models (SA-probed)");
      return models;
    } catch (e) {
      log.warn({ err: (e as Error).message }, "Vertex SA discovery failed, falling back to catalog");
    }
  }

  // 3. Fallback: just return the catalog (no project filter).
  const models = candidates.map((id) => ({ id, name: id }));
  store("vertex", models);
  log.info({ count: models.length }, "Vertex models (catalog only)");
  return models;
}

async function discoverOllama(baseUrl: string): Promise<DiscoveredModel[]> {
  const hit = cached("ollama");
  if (hit) return hit;

  const base = baseUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3_000) });
  if (!res.ok) throw new Error(`Ollama /api/tags ${res.status}`);
  const data = (await res.json()) as { models?: { name: string }[] };

  const models = (data.models ?? []).map((m) => ({ id: m.name, name: m.name }));

  store("ollama", models);
  log.info({ count: models.length }, "Ollama models discovered");
  return models;
}

// ── Unified entry point ─────────────────────────────────────────

/** OpenAI-compatible providers — all use the same /models endpoint. */
const OPENAI_COMPAT_PROVIDERS = new Set([
  "openai", "groq", "deepseek", "mistral", "xai",
  "openrouter", "together", "fireworks", "cerebras", "nvidia",
]);

/** Filter functions for providers that return too many models. */
const FILTERS: Record<string, (m: { id: string; owned_by?: string }) => boolean> = {
  openai: (m) => /^(gpt-|o[0-9]|chatgpt-)/.test(m.id) && !m.id.includes("realtime") && !m.id.includes("audio"),
  // NVIDIA NIM exposes 140+ models — verified by hitting /v1/models
  // directly. Strategy: deny-list known non-chat surfaces (embeddings,
  // safety classifiers, retrievers, parsers, audio, image-only encoders).
  // Everything else is kept so new chat models appear automatically.
  // Vision/VLM models stay — multimodal inputs work via image_url
  // content blocks on the same /v1/chat/completions endpoint
  // (docs.api.nvidia.com/nim/reference/multimodal-apis).
  nvidia: (m) => {
    const id = m.id.toLowerCase();
    if (/embed|nemoretriev|nemotron-parse|nemoretriever-parse/.test(id)) return false;
    if (/moderation|guardrail|content-safety|safety-guard|topic-control|gliner-pii|guard-\d/.test(id)) return false;
    if (/audio|whisper|riva|fastpitch|^asr-/.test(id)) return false;
    if (/^nvidia\/nvclip$|nv-clip|synthetic-video-detector|deplot$/.test(id)) return false;
    if (/-reward$|reward-/.test(id)) return false;
    return true;
  },
};

/**
 * Discover models for any provider. Returns empty array on failure
 * (network error, invalid key) — never throws.
 */
export async function discoverModelsForProvider(
  providerId: string,
  apiKey: string | undefined,
  baseUrl?: string,
): Promise<DiscoveredModel[]> {
  try {
    // Anthropic — custom auth header
    if (providerId === "anthropic") {
      return apiKey ? await discoverAnthropic(apiKey) : [];
    }

    // Google — API key as query param
    if (providerId === "google") {
      return apiKey ? await discoverGoogle(apiKey) : [];
    }

    // Vertex AI Express — API key as query param against aiplatform.googleapis.com
    if (providerId === "vertex") {
      return apiKey ? await discoverVertex(apiKey) : [];
    }

    // Ollama — local, no auth
    if (providerId === "ollama") {
      return await discoverOllama(baseUrl ?? "http://localhost:11434");
    }

    // OpenAI-compatible providers
    if (OPENAI_COMPAT_PROVIDERS.has(providerId)) {
      if (!apiKey) return [];
      const def = PROVIDERS_BY_ID.get(providerId);
      const url = baseUrl ?? def?.defaultBaseUrl ?? "https://api.openai.com/v1";
      return await discoverOpenAICompat(providerId, url, apiKey, FILTERS[providerId]);
    }

    // Unknown provider — no discovery
    return [];
  } catch (e) {
    log.warn({ provider: providerId, error: (e as Error).message }, "model discovery failed");
    return [];
  }
}

// ── Voice catalog discovery (STT models, TTS models, voices) ────

export interface DiscoveredVoice {
  readonly id: string;
  readonly name: string;
  readonly gender?: string;
}

export interface VoiceCatalog {
  readonly sttModels: DiscoveredModel[];
  readonly ttsModels: DiscoveredModel[];
  readonly ttsVoices: DiscoveredVoice[];
}

interface VoiceCacheEntry { at: number; catalog: VoiceCatalog }
const voiceCache = new Map<string, VoiceCacheEntry>();
const VOICE_CACHE_TTL = 300_000;

export function invalidateVoiceCache(): void {
  voiceCache.clear();
}

function voiceCached(id: string): VoiceCatalog | null {
  const entry = voiceCache.get(id);
  if (!entry || Date.now() - entry.at > VOICE_CACHE_TTL) return null;
  return entry.catalog;
}

function storeVoice(id: string, catalog: VoiceCatalog): void {
  voiceCache.set(id, { at: Date.now(), catalog });
}

/** ElevenLabs — /v1/voices + /v1/models. Models split into STT (Scribe) and TTS by capability flag. */
async function discoverElevenLabsVoice(apiKey: string): Promise<VoiceCatalog> {
  const hit = voiceCached("elevenlabs");
  if (hit) return hit;

  const headers = { "xi-api-key": apiKey };
  const [voicesRes, modelsRes] = await Promise.all([
    fetch("https://api.elevenlabs.io/v1/voices", {
      headers,
      signal: AbortSignal.timeout(TIMEOUT),
    }),
    fetch("https://api.elevenlabs.io/v1/models", {
      headers,
      signal: AbortSignal.timeout(TIMEOUT),
    }),
  ]);
  if (!voicesRes.ok) throw new Error(`elevenlabs /voices ${voicesRes.status}`);
  if (!modelsRes.ok) throw new Error(`elevenlabs /models ${modelsRes.status}`);

  const voicesData = (await voicesRes.json()) as {
    voices?: Array<{ voice_id: string; name: string; labels?: { gender?: string } }>;
  };
  const modelsData = (await modelsRes.json()) as Array<{
    model_id: string;
    name?: string;
    can_do_text_to_speech?: boolean;
  }>;

  const ttsVoices: DiscoveredVoice[] = (voicesData.voices ?? []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    ...(v.labels?.gender ? { gender: v.labels.gender } : {}),
  }));

  const ttsModels: DiscoveredModel[] = [];
  for (const m of modelsData) {
    if (m.can_do_text_to_speech === false) continue;
    ttsModels.push({ id: m.model_id, name: m.name ?? m.model_id });
  }

  // ElevenLabs /v1/models is TTS-only — Scribe (STT) has no listing
  // endpoint, the IDs are documented enums on /v1/speech-to-text. Seed
  // the two published models so the Settings STT dropdown populates.
  const sttModels: DiscoveredModel[] = [
    { id: "scribe_v2", name: "Scribe v2" },
    { id: "scribe_v1", name: "Scribe v1" },
  ];

  const catalog: VoiceCatalog = { sttModels, ttsModels, ttsVoices };
  storeVoice("elevenlabs", catalog);
  log.info({ provider: "elevenlabs", stt: sttModels.length, tts: ttsModels.length, voices: ttsVoices.length }, "voice catalog discovered");
  return catalog;
}

/** OpenAI — filter /v1/models for whisper-* (STT) and tts-* / *-tts (TTS). */
async function discoverOpenAIVoice(apiKey: string): Promise<VoiceCatalog> {
  const hit = voiceCached("openai");
  if (hit) return hit;

  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`openai /models ${res.status}`);
  const data = (await res.json()) as { data?: { id: string }[] };

  const sttModels: DiscoveredModel[] = [];
  const ttsModels: DiscoveredModel[] = [];
  for (const m of data.data ?? []) {
    if (/whisper|transcribe/i.test(m.id)) {
      sttModels.push({ id: m.id, name: m.id });
    } else if (/-tts|^tts-/i.test(m.id)) {
      ttsModels.push({ id: m.id, name: m.id });
    }
  }

  // OpenAI has no voice listing endpoint — the 9 built-in voices are
  // fixed. Keep them here so the dropdown isn't empty for OpenAI TTS.
  const ttsVoices: DiscoveredVoice[] = [
    { id: "nova", name: "Nova", gender: "female" },
    { id: "alloy", name: "Alloy", gender: "neutral" },
    { id: "echo", name: "Echo", gender: "male" },
    { id: "fable", name: "Fable", gender: "male" },
    { id: "onyx", name: "Onyx", gender: "male" },
    { id: "shimmer", name: "Shimmer", gender: "female" },
    { id: "ash", name: "Ash", gender: "male" },
    { id: "coral", name: "Coral", gender: "female" },
    { id: "sage", name: "Sage", gender: "female" },
  ];

  const catalog: VoiceCatalog = { sttModels, ttsModels, ttsVoices };
  storeVoice("openai", catalog);
  return catalog;
}

/** Groq — /openai/v1/models filtered for whisper-* (STT) and playai-tts-* (TTS). */
async function discoverGroqVoice(apiKey: string, baseUrl?: string): Promise<VoiceCatalog> {
  const hit = voiceCached("groq");
  if (hit) return hit;

  const base = (baseUrl ?? "https://api.groq.com/openai/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`groq /models ${res.status}`);
  const data = (await res.json()) as { data?: { id: string }[] };

  const sttModels: DiscoveredModel[] = [];
  const ttsModels: DiscoveredModel[] = [];
  for (const m of data.data ?? []) {
    if (/whisper/i.test(m.id)) {
      sttModels.push({ id: m.id, name: m.id });
    } else if (/tts/i.test(m.id) || /playai/i.test(m.id) || /orpheus/i.test(m.id)) {
      ttsModels.push({ id: m.id, name: m.id });
    }
  }

  // Groq's PlayAI voices aren't listable via API — they're hardcoded
  // by the provider. Keep the six published voices.
  const ttsVoices: DiscoveredVoice[] = [
    { id: "troy", name: "Troy", gender: "male" },
    { id: "hannah", name: "Hannah", gender: "female" },
    { id: "austin", name: "Austin", gender: "male" },
    { id: "diana", name: "Diana", gender: "female" },
    { id: "autumn", name: "Autumn", gender: "female" },
    { id: "daniel", name: "Daniel", gender: "male" },
  ];

  const catalog: VoiceCatalog = { sttModels, ttsModels, ttsVoices };
  storeVoice("groq", catalog);
  return catalog;
}

/** Cartesia — /voices is live. Models are few and static. */
async function discoverCartesiaVoice(apiKey: string): Promise<VoiceCatalog> {
  const hit = voiceCached("cartesia");
  if (hit) return hit;

  const res = await fetch("https://api.cartesia.ai/voices", {
    headers: { "X-API-Key": apiKey, "Cartesia-Version": "2024-06-10" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`cartesia /voices ${res.status}`);
  const data = (await res.json()) as Array<{ id: string; name: string; gender?: string; language?: string }>;

  const ttsVoices: DiscoveredVoice[] = data.map((v) => ({
    id: v.id,
    name: v.name,
    ...(v.gender ? { gender: v.gender } : {}),
  }));

  const catalog: VoiceCatalog = {
    sttModels: [],
    ttsModels: [
      { id: "sonic-2", name: "Sonic 2" },
      { id: "sonic-english", name: "Sonic English" },
      { id: "sonic-multilingual", name: "Sonic Multilingual" },
    ],
    ttsVoices,
  };
  storeVoice("cartesia", catalog);
  return catalog;
}

/**
 * Discover voice catalog (STT models, TTS models, voices) for a
 * provider. Returns empty catalog on failure — never throws.
 */
export async function discoverVoiceCatalog(
  providerId: string,
  apiKey: string | undefined,
  baseUrl?: string,
): Promise<VoiceCatalog> {
  if (!apiKey) return { sttModels: [], ttsModels: [], ttsVoices: [] };
  try {
    if (providerId === "elevenlabs") return await discoverElevenLabsVoice(apiKey);
    if (providerId === "openai") return await discoverOpenAIVoice(apiKey);
    if (providerId === "groq") return await discoverGroqVoice(apiKey, baseUrl);
    if (providerId === "cartesia") return await discoverCartesiaVoice(apiKey);
    return { sttModels: [], ttsModels: [], ttsVoices: [] };
  } catch (e) {
    log.warn({ provider: providerId, error: (e as Error).message }, "voice catalog discovery failed");
    return { sttModels: [], ttsModels: [], ttsVoices: [] };
  }
}
