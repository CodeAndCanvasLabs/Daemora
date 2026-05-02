/**
 * validateApiKey — verifies a provider API key by hitting the provider's
 * `/models`-style endpoint. Used by both the CLI setup wizard and the
 * Web UI's "AI Provider Keys" section so a user can't save a typo'd key
 * and discover the failure days later.
 *
 * Three outcomes:
 *
 *   ┌─────────────────────────────┬─────────────────────────────────────┐
 *   │ ok: true,  models: [...]    │ key works, here is the live catalog │
 *   │ ok: true,  skipped: true    │ provider has no public list-models  │
 *   │                             │ endpoint — accept the key as-is     │
 *   │ ok: false, status: 401|403  │ key was rejected — re-ask           │
 *   │ ok: false, status: null     │ network / timeout — re-ask          │
 *   └─────────────────────────────┴─────────────────────────────────────┘
 *
 * For providers WITHOUT a public list endpoint (Vertex SA, ElevenLabs
 * voice-only, Cartesia, Suno, etc.) we return `skipped: true` so the
 * caller doesn't block the user on a check that can't pass.
 */

import { discoverModelsForProvider, type DiscoveredModel } from "./discovery.js";

export type ValidateResult =
  | { readonly ok: true; readonly models: DiscoveredModel[]; readonly skipped?: false }
  | { readonly ok: true; readonly models: []; readonly skipped: true; readonly reason: string }
  | { readonly ok: false; readonly status: number | null; readonly message: string };

/** Providers we can't validate via a list-models endpoint. */
const SKIP_VALIDATION: ReadonlyMap<string, string> = new Map([
  // Voice / audio providers — no chat model list, key is validated at first use.
  ["elevenlabs", "voice provider — no models endpoint, key is checked at first call"],
  ["cartesia", "voice provider — no chat models endpoint"],
  ["deepgram", "speech-to-text only — no chat models endpoint"],
  ["assemblyai", "speech-to-text only — no chat models endpoint"],
  // Music
  ["suno", "music provider — no models endpoint"],
  // Vertex with SA file uses Google auth flow, not a simple key check.
  // The api-key Express path IS validated via discoverVertex though.
  ["vertex-anthropic", "Anthropic-on-Vertex uses GCP auth, not a simple key check"],
  // Search providers — keys are validated at first use.
  ["brave", "search provider — key is checked at first call"],
  // Perplexity offers /v1/models but only on enterprise tier; the key
  // works fine on /chat/completions for everyone, so don't gate it.
  ["perplexity", "key is checked at first call"],
]);

/**
 * Validate a provider API key. Never throws — always returns a
 * structured result the caller can branch on.
 */
export async function validateApiKey(
  providerId: string,
  apiKey: string,
  opts: { baseUrl?: string } = {},
): Promise<ValidateResult> {
  const trimmed = (apiKey ?? "").trim();
  if (!trimmed) {
    return { ok: false, status: null, message: "Empty key." };
  }

  // Short-circuit providers that we don't validate over the wire.
  const skipReason = SKIP_VALIDATION.get(providerId);
  if (skipReason) {
    return { ok: true, models: [], skipped: true, reason: skipReason };
  }

  try {
    const models = await discoverModelsForProvider(providerId, trimmed, opts.baseUrl);
    if (models.length > 0) {
      return { ok: true, models };
    }
    // Empty list back from a provider that DOES validate — usually means
    // the request 401'd and discovery swallowed the error. Re-run with a
    // direct call so we can get the real status.
    return await directProbe(providerId, trimmed, opts.baseUrl);
  } catch (e) {
    return { ok: false, status: null, message: (e as Error).message };
  }
}

/**
 * Direct, no-cache probe that distinguishes auth failures (401/403)
 * from "endpoint returned 200 but list is empty / wrong shape".
 */
async function directProbe(
  providerId: string,
  apiKey: string,
  baseUrl?: string,
): Promise<ValidateResult> {
  const TIMEOUT = 5_000;

  if (providerId === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    return r.ok
      ? { ok: true, models: [] }
      : { ok: false, status: r.status, message: await readErr(r) };
  }

  if (providerId === "google") {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, {
      signal: AbortSignal.timeout(TIMEOUT),
    });
    return r.ok
      ? { ok: true, models: [] }
      : { ok: false, status: r.status, message: await readErr(r) };
  }

  if (providerId === "vertex") {
    const r = await fetch(`https://aiplatform.googleapis.com/v1beta1/publishers/google/models?key=${encodeURIComponent(apiKey)}&pageSize=1`, {
      signal: AbortSignal.timeout(TIMEOUT),
    });
    return r.ok
      ? { ok: true, models: [] }
      : { ok: false, status: r.status, message: await readErr(r) };
  }

  if (providerId === "ollama") {
    const base = (baseUrl ?? "http://localhost:11434").replace(/\/+$/, "");
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    return r.ok
      ? { ok: true, models: [] }
      : { ok: false, status: r.status, message: `Ollama not reachable at ${base}` };
  }

  // OpenAI-compatible default
  const base = (baseUrl ?? defaultBaseUrl(providerId)).replace(/\/+$/, "");
  const r = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  return r.ok
    ? { ok: true, models: [] }
    : { ok: false, status: r.status, message: await readErr(r) };
}

function defaultBaseUrl(providerId: string): string {
  switch (providerId) {
    case "openai": return "https://api.openai.com/v1";
    case "groq": return "https://api.groq.com/openai/v1";
    case "deepseek": return "https://api.deepseek.com/v1";
    case "mistral": return "https://api.mistral.ai/v1";
    case "xai": return "https://api.x.ai/v1";
    case "openrouter": return "https://openrouter.ai/api/v1";
    case "together": return "https://api.together.xyz/v1";
    case "fireworks": return "https://api.fireworks.ai/inference/v1";
    case "cerebras": return "https://api.cerebras.ai/v1";
    case "nvidia": return "https://integrate.api.nvidia.com/v1";
    case "perplexity": return "https://api.perplexity.ai";
    default: return "https://api.openai.com/v1";
  }
}

async function readErr(r: Response): Promise<string> {
  try {
    const text = await r.text();
    if (text.length > 200) return `${r.status} ${r.statusText}`;
    return `${r.status} ${r.statusText}: ${text}`;
  } catch {
    return `${r.status} ${r.statusText}`;
  }
}
