import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOllama } from "ollama-ai-provider";
import { models, fallbackChains } from "../config/models.js";

/**
 * Provider factory - lazily created so vault secrets are available.
 * Per-tenant apiKeys overlay: if apiKeys[KEY] is set, create a fresh provider instance
 * (never cached) to avoid cross-tenant bleed in concurrent requests.
 */
const providerCache = {};

function getProvider(name, apiKeys = {}) {
  const keyMap = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", google: "GOOGLE_AI_API_KEY" };
  const envKeyName = keyMap[name];
  const tenantKey = envKeyName ? apiKeys[envKeyName] : null;

  if (name === "ollama") {
    if (providerCache[name]) return providerCache[name];
    providerCache[name] = createOllama({ baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434/api" });
    return providerCache[name];
  }

  const globalKey = envKeyName ? process.env[envKeyName] : null;
  if (!tenantKey && !globalKey) return null;

  if (tenantKey) {
    // Per-tenant key: always create a fresh instance - never cache, prevents cross-tenant bleed
    if (name === "openai")    return createOpenAI({ apiKey: tenantKey });
    if (name === "anthropic") return createAnthropic({ apiKey: tenantKey });
    if (name === "google")    return createGoogleGenerativeAI({ apiKey: tenantKey });
  }

  // Global key: existing singleton cache behavior (zero overhead for single-user mode)
  if (providerCache[name]) return providerCache[name];
  if (name === "openai")    providerCache[name] = createOpenAI({ apiKey: globalKey });
  if (name === "anthropic") providerCache[name] = createAnthropic({ apiKey: globalKey });
  if (name === "google")    providerCache[name] = createGoogleGenerativeAI({ apiKey: globalKey });
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
  if (!meta && modelId.includes(":")) {
    const [providerName, modelName] = modelId.split(":", 2);
    const knownProviders = ["openai", "anthropic", "google", "ollama"];
    if (knownProviders.includes(providerName)) {
      console.log(`[ModelRouter] Model "${modelId}" not in registry — using dynamic passthrough`);
      meta = {
        provider: providerName,
        model: modelName,
        contextWindow: 128_000,
        compactAt: 90_000,
        costPer1kInput: 0.001,
        costPer1kOutput: 0.004,
        capabilities: ["text", "tools"],
        tier: "standard",
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

  return {
    model: provider(meta.model),
    meta,
  };
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
  const cheapChain = ["google:gemini-2.0-flash", "openai:gpt-4.1-mini", "anthropic:claude-haiku-4-5"];
  for (const modelId of cheapChain) {
    try {
      const result = getModel(modelId, apiKeys);
      return { ...result, modelId };
    } catch {
      continue;
    }
  }
  // Last resort: whatever the default is
  const defaultId = process.env.DEFAULT_MODEL || "openai:gpt-4.1-mini";
  return { ...getModel(defaultId, apiKeys), modelId: defaultId };
}

/**
 * List all available models (ones that have API keys configured).
 */
export function listAvailableModels() {
  const available = [];
  for (const modelId of Object.keys(models)) {
    try {
      getModel(modelId);
      available.push({ id: modelId, ...models[modelId] });
    } catch {
      // skip unavailable
    }
  }
  return available;
}

// ── Task-Type Model Routing ────────────────────────────────────────────────────

const _profileEnvMap = {
  coder:      "CODE_MODEL",
  researcher: "RESEARCH_MODEL",
  writer:     "WRITER_MODEL",
  analyst:    "ANALYST_MODEL",
};

/**
 * Resolve the best model for a given agent profile, using a priority chain:
 *   1. explicitModel (caller override)
 *   2. Per-tenant modelRoutes[profile]
 *   3. Global CODE_MODEL / RESEARCH_MODEL / WRITER_MODEL / ANALYST_MODEL env vars
 *   4. Per-tenant general model override
 *   5. DEFAULT_MODEL env var / hardcoded default
 *
 * @param {string|null} profile       - e.g. "coder", "researcher", "writer", "analyst"
 * @param {object}      tenantConfig  - resolvedConfig from TenantManager (may have .modelRoutes, .model)
 * @param {string|null} explicitModel - Caller-supplied model override (highest priority)
 * @returns {string} Resolved model ID
 */
export function resolveModelForProfile(profile, tenantConfig = {}, explicitModel = null) {
  if (explicitModel) return explicitModel;
  if (profile && tenantConfig.modelRoutes?.[profile]) return tenantConfig.modelRoutes[profile];
  if (profile && process.env[_profileEnvMap[profile]]) return process.env[_profileEnvMap[profile]];
  if (tenantConfig.model) return tenantConfig.model;
  return process.env.DEFAULT_MODEL || "openai:gpt-4.1-mini";
}

/**
 * Get the task-type model for a profile from global env vars only.
 * Utility for callers without a tenant config.
 *
 * @param {string|null} profile - e.g. "coder", "researcher"
 * @returns {string} Model ID
 */
export function getTaskTypeModel(profile) {
  return (profile && process.env[_profileEnvMap[profile]]) || process.env.DEFAULT_MODEL || "openai:gpt-4.1-mini";
}
