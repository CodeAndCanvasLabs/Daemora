import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
// ollama-ai-provider-v2 implements AI SDK spec v2 (required for AI SDK 5+).
// The older `ollama-ai-provider` throws "Unsupported model version v1" and
// isn't installed anymore — importing it here crashed Node on startup.
import { createOllama } from "ollama-ai-provider-v2";
import { models, fallbackChains } from "../config/models.js";

/**
 * Provider registry - maps provider name → { envKey, baseURL (for OpenAI-compat), factory }.
 * xAI, DeepSeek, Mistral use OpenAI-compatible APIs with custom baseURL.
 */
const PROVIDERS = {
  openai:    { envKey: "OPENAI_API_KEY" },
  anthropic: { envKey: "ANTHROPIC_API_KEY" },
  google:    { envKey: "GOOGLE_AI_API_KEY" },
  xai:       { envKey: "XAI_API_KEY",      baseURL: "https://api.x.ai/v1" },
  deepseek:  { envKey: "DEEPSEEK_API_KEY",  baseURL: "https://api.deepseek.com" },
  mistral:   { envKey: "MISTRAL_API_KEY",   baseURL: "https://api.mistral.ai/v1" },
  openrouter: { envKey: "OPENROUTER_API_KEY", baseURL: "https://openrouter.ai/api/v1" },
  groq:      { envKey: "GROQ_API_KEY",      baseURL: "https://api.groq.com/openai/v1" },
  ollama:    { envKey: null },
};

/**
 * Provider factory - lazily created so vault secrets are available.
 * Per-tenant apiKeys overlay: if apiKeys[KEY] is set, create a fresh provider instance
 * (never cached) to avoid cross-tenant bleed in concurrent requests.
 */
const providerCache = {};

function _createProvider(name, apiKey) {
  const info = PROVIDERS[name];
  if (name === "openai")    return createOpenAI({ apiKey });
  if (name === "anthropic") return createAnthropic({ apiKey });
  if (name === "google")    return createGoogleGenerativeAI({ apiKey });
  // OpenRouter - include ranking headers
  if (name === "openrouter") return createOpenAI({ apiKey, baseURL: info.baseURL, headers: { "HTTP-Referer": "https://daemora.com", "X-OpenRouter-Title": "Daemora" } });
  // OpenAI-compatible providers (xAI, DeepSeek, Mistral)
  if (info?.baseURL)        return createOpenAI({ apiKey, baseURL: info.baseURL });
  return null;
}

function getProvider(name, apiKeys = {}) {
  const info = PROVIDERS[name];
  if (!info) return null;

  if (name === "ollama") {
    if (providerCache[name]) return providerCache[name];
    providerCache[name] = createOllama({ baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434/api" });
    return providerCache[name];
  }

  const tenantKey = info.envKey ? apiKeys[info.envKey] : null;
  const globalKey = info.envKey ? process.env[info.envKey] : null;
  if (!tenantKey && !globalKey) return null;

  // Per-tenant key: always create a fresh instance - never cache, prevents cross-tenant bleed
  if (tenantKey) return _createProvider(name, tenantKey);

  // Global key: singleton cache (zero overhead for single-user mode)
  if (providerCache[name]) return providerCache[name];
  providerCache[name] = _createProvider(name, globalKey);
  return providerCache[name] || null;
}

/**
 * Get a Vercel AI SDK model instance from a "provider:model" string.
 *
 * @param {string} modelId - e.g. "openai:gpt-4.1-mini" or "anthropic:claude-sonnet-4-6"
 * @param {object} apiKeys - Per-tenant API key overlay { OPENAI_API_KEY: "...", ... }
 * @returns {{ model: object, meta: object }} AI SDK model instance + metadata
 */
export function getModel(modelId, apiKeys = {}) {
  let meta = models[modelId];

  // Passthrough: if model isn't in the registry but follows "provider:model" format,
  // create a dynamic entry so new models work without updating the registry.
  // Split on first colon only — Ollama tags contain colons ("gemma4:latest").
  if (!meta && modelId.includes(":")) {
    const sep = modelId.indexOf(":");
    const providerName = modelId.slice(0, sep);
    const modelName = modelId.slice(sep + 1);
    const knownProviders = Object.keys(PROVIDERS);
    if (knownProviders.includes(providerName)) {
      console.log(`[ModelRouter] Model "${modelId}" not in registry - using dynamic passthrough`);
      const isLocal = providerName === "ollama";
      meta = {
        provider: providerName,
        model: modelName,
        contextWindow: 128_000,
        compactAt: 90_000,
        costPer1kInput: isLocal ? 0 : 0.001,
        costPer1kOutput: isLocal ? 0 : 0.004,
        capabilities: ["text", "tools"],
        tier: isLocal ? "local" : "standard",
      };
    }
  }

  if (!meta) {
    throw new Error(`Unknown model: ${modelId}. Available: ${Object.keys(models).join(", ")}`);
  }

  const provider = getProvider(meta.provider, apiKeys);
  if (!provider) {
    throw new Error(
      `Provider "${meta.provider}" not configured. Set the API key in .env (e.g. ${meta.provider.toUpperCase()}_API_KEY).`
    );
  }

  // Use Chat Completions API for OpenAI + OpenAI-compatible providers (xAI, DeepSeek, Mistral)
  const openaiCompat = PROVIDERS[meta.provider]?.baseURL || meta.provider === "openai";
  const model = openaiCompat ? provider.chat(meta.model) : provider(meta.model);

  return { model, meta };
}

/**
 * Detect which providers have API keys configured.
 * Returns set of provider names with available keys (global or tenant).
 */
/**
 * Clear cached provider instances so new API keys take effect.
 */
export function clearProviderCache() {
  for (const key of Object.keys(providerCache)) delete providerCache[key];
}

function _availableProviders(apiKeys = {}) {
  const available = new Set();
  for (const [name, info] of Object.entries(PROVIDERS)) {
    if (name === "ollama") {
      // Ollama is always "available" (local, no key required)
      available.add(name);
      continue;
    }
    if (!info.envKey) continue;
    if (apiKeys[info.envKey] || process.env[info.envKey]) available.add(name);
  }
  return available;
}

/**
 * Resolve the default model based on available provider keys.
 * Priority: DEFAULT_MODEL env → first available provider's best standard model.
 * Never crashes - returns first available model from any configured provider.
 *
 * @param {object} apiKeys - Per-tenant API key overlay
 * @returns {string} Resolved model ID (e.g. "anthropic:claude-sonnet-4-6")
 */
export function resolveDefaultModel(apiKeys = {}) {
  const explicit = process.env.DEFAULT_MODEL;
  if (explicit) {
    // Verify the explicit default is actually usable
    const provider = explicit.split(":")[0];
    const available = _availableProviders(apiKeys);
    if (available.has(provider)) return explicit;
    console.log(`[ModelRouter] DEFAULT_MODEL "${explicit}" provider not configured - auto-detecting`);
  }

  const available = _availableProviders(apiKeys);

  // Preferred defaults per provider (best standard-tier model for each).
  const providerDefaults = [
    { provider: "anthropic",  model: "anthropic:claude-sonnet-4-6" },
    { provider: "openai",     model: "openai:gpt-5.2" },
    { provider: "google",     model: "google:gemini-2.5-pro" },
    { provider: "xai",        model: "xai:grok-4" },
    { provider: "groq",       model: "groq:openai/gpt-oss-120b" },
    { provider: "deepseek",   model: "deepseek:deepseek-chat" },
    { provider: "mistral",    model: "mistral:mistral-large-latest" },
    { provider: "openrouter", model: "openrouter:anthropic/claude-sonnet-4" },
    { provider: "ollama",     model: "ollama:llama3.1" },
  ];

  for (const { provider, model } of providerDefaults) {
    if (!available.has(provider)) continue;
    // Ollama: use the first actually-installed model, not a hardcoded name.
    if (provider === "ollama") {
      const installed = _discoverOllamaModelsCached();
      if (installed.length > 0) return installed[0].id;
    }
    return model;
  }

  return "ollama:llama3.1";
}

/**
 * Get model with fallback chain.
 * Tries the preferred model first, then falls through the chain.
 *
 * @param {string} preferredModelId - e.g. "openai:gpt-4.1-mini"
 * @param {object} apiKeys - Per-tenant API key overlay
 * @returns {{ model: object, meta: object, modelId: string }}
 */
export function getModelWithFallback(preferredModelId, apiKeys = {}) {
  // Try preferred model first
  try {
    const result = getModel(preferredModelId, apiKeys);
    return { ...result, modelId: preferredModelId };
  } catch (e) {
    console.log(`[ModelRouter] Preferred model "${preferredModelId}" unavailable: ${e.message}`);
  }

  // Find the fallback chain for this model's tier
  const meta = models[preferredModelId];
  const tier = meta?.tier || "cheap";
  const chain = fallbackChains[tier] || fallbackChains.cheap;

  for (const fallbackId of chain) {
    if (fallbackId === preferredModelId) continue;
    try {
      const result = getModel(fallbackId, apiKeys);
      console.log(`[ModelRouter] Falling back to "${fallbackId}"`);
      return { ...result, modelId: fallbackId };
    } catch (e) {
      continue;
    }
  }

  throw new Error(`No available model found. Tried: ${preferredModelId} + fallback chain.`);
}

/**
 * Get the cheapest available model (for compaction/summarization).
 *
 * @param {object} apiKeys - Per-tenant API key overlay
 */
export function getCheapModel(apiKeys = {}) {
  const cheapChain = [
    "google:gemini-2.0-flash", "openai:gpt-4.1-mini", "anthropic:claude-haiku-4-5",
    "google:gemini-2.5-flash", "deepseek:deepseek-chat", "mistral:mistral-small-latest",
    "xai:grok-3-mini-beta", "ollama:llama3.1",
  ];
  for (const modelId of cheapChain) {
    try {
      const result = getModel(modelId, apiKeys);
      return { ...result, modelId };
    } catch {
      continue;
    }
  }
  // Last resort: use whatever provider is available
  const defaultId = resolveDefaultModel(apiKeys);
  return { ...getModel(defaultId, apiKeys), modelId: defaultId };
}

/**
 * List all available models. Cloud providers come from the static registry;
 * Ollama models are discovered live from `${OLLAMA_BASE_URL}/api/tags` so
 * users only see what they've actually pulled. Discovery is cached for 60s.
 */
export function listAvailableModels() {
  const available = [];
  for (const modelId of Object.keys(models)) {
    if (modelId.startsWith("ollama:")) continue;
    try {
      getModel(modelId);
      available.push({ id: modelId, ...models[modelId] });
    } catch { /* skip unavailable */ }
  }
  for (const m of _discoverOllamaModelsCached()) available.push(m);
  return available;
}

let _ollamaCache = { at: 0, models: [] };
let _ollamaRefreshPromise = null;
const _OLLAMA_TTL_MS = 60_000;

function _discoverOllamaModelsCached() {
  const now = Date.now();
  if (now - _ollamaCache.at < _OLLAMA_TTL_MS) return _ollamaCache.models;
  if (!_ollamaRefreshPromise) {
    _ollamaRefreshPromise = _refreshOllamaModels()
      .catch(() => {})
      .finally(() => { _ollamaRefreshPromise = null; });
  }
  return _ollamaCache.models;
}

async function _refreshOllamaModels() {
  const raw = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  const base = raw.replace(/\/+$/, "").replace(/\/(api|v1)$/, "");
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`tags ${res.status}`);
    const data = await res.json();
    _ollamaCache = {
      at: Date.now(),
      models: (data.models || []).map((m) => ({
        id: `ollama:${m.name}`,
        provider: "ollama",
        model: m.name,
        contextWindow: 8192,
        compactAt: 6500,
        costPer1kInput: 0,
        costPer1kOutput: 0,
        capabilities: ["text", "tools"],
        tier: "local",
      })),
    };
  } catch {
    _ollamaCache = { at: Date.now(), models: [] };
  }
}

export async function refreshOllamaNow() {
  await _refreshOllamaModels();
  return _ollamaCache.models;
}

_refreshOllamaModels().catch(() => {});

// ── Thinking Level Resolution ──────────────────────────────────────────────────

const _thinkingAliases = { on: "low", min: "minimal", max: "high" };

/**
 * Resolve thinking config for a model + level combination.
 * Returns params to merge into the generateObject call, or null if no thinking.
 *
 * @param {string} modelId - e.g. "anthropic:claude-sonnet-4-6"
 * @param {string} level   - "auto"|"off"|"minimal"|"low"|"medium"|"high"|"xhigh"
 * @returns {{ thinkingParams: object } | null}
 */
export function resolveThinkingConfig(modelId, level = "auto") {
  const normalized = _thinkingAliases[level] || level;
  if (normalized === "off" || normalized === "auto") return null;

  const provider = modelId.split(":")[0];

  // Anthropic: thinking.budget_tokens
  if (provider === "anthropic") {
    const budgetMap = { minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384 };
    const budget = budgetMap[normalized];
    if (!budget) return null;
    return { thinkingParams: { thinking: { type: "enabled", budgetTokens: budget } } };
  }

  // OpenAI: reasoning.effort (only for o-series models)
  if (provider === "openai") {
    const effortMap = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" };
    const effort = effortMap[normalized];
    if (!effort) return null;
    return { thinkingParams: { reasoning: { effort } } };
  }

  // Google: thinkingConfig.thinkingBudget
  if (provider === "google") {
    const budgetMap = { minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384 };
    const budget = budgetMap[normalized];
    if (!budget) return null;
    return { thinkingParams: { thinkingConfig: { thinkingBudget: budget } } };
  }

  return null;
}

// ── Sub-Agent Model Resolution ────────────────────────────────────────────────

/**
 * Resolve model for a sub-agent.
 * Priority: SUB_AGENT_MODEL (.env) → parent model → DEFAULT_MODEL
 *
 * @param {string|null} parentModel - Parent agent's resolved model
 * @returns {string} Resolved model ID
 */
export function resolveSubAgentModel(parentModel = null, apiKeys = {}) {
  return process.env.SUB_AGENT_MODEL || parentModel || resolveDefaultModel(apiKeys);
}

// ── Error Classification + Provider Cooldown ─────────────────────────────────

const TRANSIENT_PATTERNS = /429|503|overloaded|rate.limit|capacity|try.again|too.many.requests|server.error|temporarily|timeout|ECONNRESET|ETIMEDOUT/i;
const PERMANENT_PATTERNS = /401|403|404|invalid.api.key|model.not.found|billing|insufficient.quota|deprecated|unsupported|does.not.exist/i;

const providerCooldowns = new Map(); // provider → { until: Date.now() + ms }

/**
 * Classify an API error as transient (retryable) or permanent (skip to fallback).
 * @param {Error} error
 * @returns {{ type: "transient"|"permanent"|"unknown", retryAfterMs: number|null }}
 */
export function classifyError(error) {
  const msg = error?.message || "";
  const status = error?.status || error?.statusCode || error?.data?.status || 0;

  // Check HTTP status first
  if (status === 429 || status === 503 || status === 502 || status === 500) {
    const retryAfter = error?.headers?.["retry-after"];
    const retryMs = retryAfter ? parseInt(retryAfter) * 1000 : null;
    return { type: "transient", retryAfterMs: retryMs || 5000 };
  }
  if (status === 401 || status === 403 || status === 404) {
    return { type: "permanent", retryAfterMs: null };
  }

  // Check message patterns
  if (TRANSIENT_PATTERNS.test(msg)) return { type: "transient", retryAfterMs: 5000 };
  if (PERMANENT_PATTERNS.test(msg)) return { type: "permanent", retryAfterMs: null };

  return { type: "unknown", retryAfterMs: null };
}

/**
 * Mark a provider as temporarily unavailable.
 */
export function cooldownProvider(modelId, durationMs = 60000) {
  const provider = modelId.split(":")[0];
  providerCooldowns.set(provider, { until: Date.now() + durationMs });
  console.log(`[ModelRouter] Provider "${provider}" cooled down for ${durationMs / 1000}s`);
}

/**
 * Get a runtime fallback model, skipping cooled-down providers.
 * @param {string} currentModelId - The model that just failed
 * @param {object} apiKeys
 * @returns {{ model, meta, modelId } | null}
 */
export function getRuntimeFallback(currentModelId, apiKeys = {}) {
  const currentProvider = currentModelId.split(":")[0];
  const meta = models[currentModelId];
  const tier = meta?.tier || "cheap";
  const chain = fallbackChains[tier] || fallbackChains.cheap;
  const now = Date.now();

  for (const fallbackId of chain) {
    if (fallbackId === currentModelId) continue;
    const fbProvider = fallbackId.split(":")[0];

    // Skip same provider (it's probably down too)
    if (fbProvider === currentProvider) continue;

    // Skip cooled-down providers
    const cooldown = providerCooldowns.get(fbProvider);
    if (cooldown && cooldown.until > now) continue;

    try {
      const result = getModel(fallbackId, apiKeys);
      console.log(`[ModelRouter] Runtime fallback: ${currentModelId} → ${fallbackId}`);
      return { ...result, modelId: fallbackId };
    } catch { continue; }
  }
  return null;
}
