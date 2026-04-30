/**
 * ModelRouter — resolves "provider:model" strings to AI SDK
 * LanguageModel instances. Reactive: clears its cache whenever the
 * vault changes so a key add/delete takes effect without restart.
 *
 * Resolution rules:
 *   1. If `id` is the literal default sentinel (null / undefined),
 *      fall back to the first available provider in the user's
 *      preference order.
 *   2. The format is `provider:model`, where `model` may itself
 *      contain colons (e.g. `ollama:gemma4:latest`). Split on the
 *      FIRST colon only.
 *   3. Local-only providers (ollama) need no key.
 *   4. Anything else needs the matching vault secret unlocked + set,
 *      else throws ProviderUnavailableError with an actionable message.
 */

import { existsSync } from "node:fs";
import type { LanguageModel } from "ai";

import type { ConfigManager } from "../config/ConfigManager.js";
import { ProviderUnavailableError, ValidationError } from "../util/errors.js";
import { createLogger } from "../util/logger.js";
import { PROVIDERS_BY_ID } from "./providers.js";
import { isKnownProvider, providerIds, providerRegistry } from "./registry.js";
import type { ProviderId, ResolvedModel } from "./types.js";

const log = createLogger("models");

// Vertex Service Account auth — opt-in via env. When unset, every
// helper below short-circuits and the regular Express (API key) path
// is used. Set these to point Vertex Anthropic / Veo at a project
// where Marketplace partner models are enabled. See README → Vertex.
//
// Claude has separate region availability from Veo: us-central1 has
// Veo but no Claude; us-east5 covers every Claude model in the SDK
// list. The two location constants below should NOT be merged.
const VERTEX_SA_PROJECT_ID = process.env["DAEMORA_VERTEX_PROJECT_ID"] ?? "";
const VERTEX_SA_LOCATION = process.env["DAEMORA_VERTEX_LOCATION"] ?? "us-central1";
// Both Gemini and Anthropic on Vertex SA route through `global` by
// default. Reasons:
//   - Gemini 3.x previews are reachable ONLY on global (every region 404s).
//   - Anthropic 4.x ids (sonnet/opus/haiku 4.6/4.7 with no @date suffix)
//     are advertised on us-east5 / europe-west1 / asia-southeast1 / global,
//     so global covers all of them in one place.
//   - Older 3.x Claude (3-7-sonnet, 3-5-haiku) is documented for us-east5
//     + europe-west1 only — they may 404 on global. If you hit one of
//     those, override DAEMORA_VERTEX_ANTHROPIC_LOCATION=us-east5.
const VERTEX_SA_ANTHROPIC_LOCATION = process.env["DAEMORA_VERTEX_ANTHROPIC_LOCATION"] ?? "global";
const VERTEX_SA_GEMINI_LOCATION = process.env["DAEMORA_VERTEX_GEMINI_LOCATION"] ?? "global";
const VERTEX_SA_KEY_PATH = process.env["DAEMORA_VERTEX_SA_KEY_PATH"] ?? "";

interface CacheEntry {
  readonly providerKey: string;          // hash of (apiKey, baseUrl) so we know to invalidate
  readonly model: LanguageModel;
}

// No hardcoded model names. User picks their model in Settings.
// If nothing is configured, we error clearly.

export class ModelRouter {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly cfg: ConfigManager) {
    // Any change to a provider's auth keys invalidates every cached
    // model for that provider — cacheKey is `${provider}:${modelName}`
    // so we drop everything starting with `${provider}:`.
    cfg.on("change", ({ key }: { key: string }) => {
      const drop = (provider: ProviderId) => {
        for (const k of [...this.cache.keys()]) {
          if (k.startsWith(`${provider}:`)) this.cache.delete(k);
        }
        log.info({ provider, key }, "model cache invalidated by config change");
      };
      for (const p of providerIds) {
        if (providerRegistry[p].apiKeyEnv === key) drop(p);
      }
    });
    cfg.vault.on("locked", () => {
      this.cache.clear();
      log.info("model cache cleared (vault locked)");
    });
  }

  /**
   * Resolve the user's configured default model. No silent fallbacks
   * to random providers — if it's not configured or the provider is
   * unavailable, throw a clear error the UI can show.
   */
  resolveDefault(): string {
    if (!this.cfg.vault.isUnlocked()) {
      throw new ProviderUnavailableError(
        "Vault is locked. Unlock it so Daemora can access your API keys.",
        undefined,
      );
    }

    const model = this.cfg.setting("DEFAULT_MODEL");
    if (!model) {
      throw new ProviderUnavailableError(
        "No default model configured. Go to Settings and pick a model.",
        undefined,
      );
    }

    const provider = providerOf(model);
    if (!provider) {
      throw new ValidationError(`Invalid DEFAULT_MODEL "${model}". Expected "provider:model".`);
    }
    if (!this.providerAvailable(provider)) {
      throw new ProviderUnavailableError(
        provider,
        providerRegistry[provider].apiKeyEnv ?? undefined,
      );
    }

    return model;
  }

  /**
   * Look up the advertised context window for a "provider:model" id.
   * Falls back to 200_000 if unknown (safe assumption for modern chat
   * models). Used by compaction to decide when to trigger.
   */
  contextWindow(id: string): number {
    const split = splitOnFirstColon(id);
    if (!split) return 200_000;
    const [provider, modelName] = split;
    const pdef = PROVIDERS_BY_ID.get(provider);
    if (!pdef) return 200_000;
    const mdef = pdef.models.find((m) => m.id === modelName);
    return mdef?.contextWindow ?? 200_000;
  }

  /** True if this provider has the credentials it needs to run. */
  providerAvailable(provider: ProviderId): boolean {
    if (provider === "vertex-anthropic") return existsSync(VERTEX_SA_KEY_PATH);
    const info = providerRegistry[provider];
    if (info.apiKeyEnv === null) return true;            // keyless
    return this.cfg.vault.get(info.apiKeyEnv) !== undefined;
  }

  /**
   * Resolve a "cheap" fast model for background tasks (session-search
   * summarization, compaction summaries, background reviewer). Tries in
   * order: env override → groq llama 8b → anthropic haiku → openai mini
   * → ollama. Throws ProviderUnavailableError if none are available.
   *
   * Callers can always override with a `model` arg — this is just the
   * default when nothing is specified.
   */
  async getCheap(): Promise<ResolvedModel> {
    const override = this.cfg.setting("DAEMORA_CHEAP_MODEL" as never) as string | undefined
      ?? process.env["DAEMORA_CHEAP_MODEL"];
    if (override && typeof override === "string" && override.includes(":")) {
      return this.resolve(override);
    }
    const candidates: string[] = [
      "groq:llama-3.1-8b-instant",
      "anthropic:claude-haiku-4-5",
      "openai:gpt-4o-mini",
      "google:gemini-2.5-flash-lite",
      "ollama:llama3.2",
    ];
    for (const id of candidates) {
      const provider = id.split(":", 1)[0] as ProviderId;
      if (!this.providerAvailable(provider)) continue;
      try { return await this.resolve(id); } catch { /* try next */ }
    }
    throw new ProviderUnavailableError("No cheap model provider is configured for background tasks.");
  }

  /** Resolve a "provider:model" string to a usable LanguageModel. */
  async resolve(id: string): Promise<ResolvedModel> {
    const split = splitOnFirstColon(id);
    if (!split) throw new ValidationError(`Invalid model id "${id}". Expected "provider:model".`);
    const [provider, modelName] = split;

    if (!isKnownProvider(provider)) {
      throw new ValidationError(`Unknown provider "${provider}". Known: ${providerIds.join(", ")}`);
    }

    const info = providerRegistry[provider];
    const apiKey = info.apiKeyEnv ? this.cfg.vault.get(info.apiKeyEnv) : undefined;

    if (info.apiKeyEnv !== null && !apiKey) {
      throw new ProviderUnavailableError(provider, info.apiKeyEnv);
    }

    const baseUrl = info.baseUrlEnv
      ? (this.cfg.settings.has("OLLAMA_BASE_URL" as never) && info.id === "ollama"
          ? this.cfg.setting("OLLAMA_BASE_URL")
          : info.defaultBaseUrl)
      : undefined;

    // Cache the BOUND model per (provider, modelName). Earlier versions
    // keyed only on provider — that returned the first model ever asked
    // for, on every subsequent call. The factory functions return a
    // fresh LanguageModel for each modelName, so we have to cache them
    // separately.
    const cacheKey = `${provider}:${modelName}`;
    const providerKey = `${apiKey?.hint() ?? ""}|${baseUrl ?? ""}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.providerKey === providerKey) {
      return { id, provider, modelName, model: cached.model };
    }

    const model = await this.buildModel(provider, modelName, apiKey?.reveal(), baseUrl);
    this.cache.set(cacheKey, { providerKey, model });
    return { id, provider, modelName, model };
  }

  /**
   * Lazily import the right AI SDK adapter and build a LanguageModel.
   * Adapters are loaded once and reused — see cache above.
   */
  private async buildModel(
    provider: ProviderId,
    modelName: string,
    apiKey: string | undefined,
    baseUrl: string | undefined,
  ): Promise<LanguageModel> {
    switch (provider) {
      case "anthropic": {
        const { createAnthropic } = await import("@ai-sdk/anthropic");
        if (!apiKey) throw new ProviderUnavailableError(provider, "ANTHROPIC_API_KEY");
        return createAnthropic({ apiKey })(modelName);
      }
      case "openai": {
        const { createOpenAI } = await import("@ai-sdk/openai");
        if (!apiKey) throw new ProviderUnavailableError(provider, "OPENAI_API_KEY");
        return createOpenAI({ apiKey }).chat(modelName);
      }
      case "google": {
        const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
        if (!apiKey) throw new ProviderUnavailableError(provider, "GOOGLE_AI_API_KEY");
        return createGoogleGenerativeAI({ apiKey })(modelName);
      }
      case "vertex": {
        // Two auth modes:
        //  - SA JSON + project/location → unlocks preview models
        //    (gemini-3.x-*-preview) which are pinned to `global` and
        //    not reachable from Express keys. Preferred when the
        //    TEMP SA file is present.
        //  - Express API key → simpler, region-agnostic, but only
        //    sees GA models. Fallback when no SA file.
        const { createVertex } = await import("@ai-sdk/google-vertex");
        if (existsSync(VERTEX_SA_KEY_PATH)) {
          return createVertex({
            project: VERTEX_SA_PROJECT_ID,
            location: VERTEX_SA_GEMINI_LOCATION,
            googleAuthOptions: {
              keyFile: VERTEX_SA_KEY_PATH,
              scopes: ["https://www.googleapis.com/auth/cloud-platform"],
            },
          })(modelName);
        }
        if (!apiKey) throw new ProviderUnavailableError(provider, "GOOGLE_VERTEX_API_KEY");
        return createVertex({ apiKey })(modelName);
      }
      case "vertex-anthropic": {
        // Claude on Vertex — Express mode (API-key) does NOT cover
        // partner models, so we authenticate via Service Account JSON.
        // Reuses the same SA file generateVideo.ts uses for Veo.
        if (!VERTEX_SA_KEY_PATH || !existsSync(VERTEX_SA_KEY_PATH)) {
          throw new ProviderUnavailableError(
            provider,
            `Set DAEMORA_VERTEX_SA_KEY_PATH (and DAEMORA_VERTEX_PROJECT_ID) — Claude on Vertex needs SA auth (Express keys only cover Gemini).`,
          );
        }
        if (!VERTEX_SA_PROJECT_ID) {
          throw new ProviderUnavailableError(provider, "DAEMORA_VERTEX_PROJECT_ID");
        }
        const { createVertexAnthropic } = await import("@ai-sdk/google-vertex/anthropic");
        return createVertexAnthropic({
          project: VERTEX_SA_PROJECT_ID,
          location: VERTEX_SA_ANTHROPIC_LOCATION,
          googleAuthOptions: {
            keyFile: VERTEX_SA_KEY_PATH,
            scopes: ["https://www.googleapis.com/auth/cloud-platform"],
          },
        })(modelName);
      }
      case "groq": {
        const { createOpenAI } = await import("@ai-sdk/openai");
        if (!apiKey) throw new ProviderUnavailableError(provider, "GROQ_API_KEY");
        return createOpenAI({
          apiKey,
          baseURL: baseUrl ?? providerRegistry.groq.defaultBaseUrl!,
        }).chat(modelName);
      }
      case "nvidia": {
        const { createOpenAI } = await import("@ai-sdk/openai");
        if (!apiKey) throw new ProviderUnavailableError(provider, "NVIDIA_API_KEY");
        return createOpenAI({
          apiKey,
          baseURL: baseUrl ?? providerRegistry.nvidia.defaultBaseUrl!,
        }).chat(modelName);
      }
      case "ollama": {
        const { createOllama } = await import("ollama-ai-provider-v2");
        const url = baseUrl ?? providerRegistry.ollama.defaultBaseUrl!;
        return createOllama({ baseURL: stripApiSuffix(url) + "/api" })(modelName);
      }
      default:
        throw new ValidationError(`Unhandled provider ${provider}`);
    }
  }

  /** AI SDK provider factories return a function — call it with the model name to get a LanguageModel. */
  private bindModel(model: LanguageModel, _modelName: string): LanguageModel {
    return model;
  }
}

function splitOnFirstColon(id: string): [string, string] | null {
  const i = id.indexOf(":");
  if (i <= 0 || i === id.length - 1) return null;
  return [id.slice(0, i), id.slice(i + 1)];
}

function providerOf(id: string): ProviderId | null {
  const s = splitOnFirstColon(id);
  if (!s) return null;
  return isKnownProvider(s[0]) ? s[0] : null;
}

function stripApiSuffix(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/(api|v1)$/, "");
}
