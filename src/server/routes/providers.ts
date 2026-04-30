/**
 * /api/providers — unified provider + model + voice endpoint.
 *
 * One call returns everything: every provider, its configuration
 * status, dynamically-discovered models, voice capabilities, and
 * active selections. The UI renders directly from this — zero
 * client-side key checking or cross-referencing.
 *
 * /api/providers/:id/models — force-refresh models for one provider.
 * /api/models + /api/models/all — backwards-compat for existing UI.
 */

import type { Express, Request, Response } from "express";

import {
  discoverModelsForProvider,
  discoverVoiceCatalog,
  invalidateModelCache,
  invalidateVoiceCache,
  type DiscoveredModel,
} from "../../models/discovery.js";
import {
  PROVIDER_CATALOG,
  PROVIDERS_BY_ID,
  defaultImageModelFor,
  defaultModelFor,
  defaultSttModelFor,
  defaultTtsModelFor,
  defaultTtsVoiceFor,
  defaultVideoModelFor,
  type ProviderDef,
} from "../../models/providers.js";
import type { ServerDeps } from "../index.js";

export function mountProviderRoutes(app: Express, deps: ServerDeps): void {
  // Invalidate caches when vault state changes — keys may have appeared
  // or disappeared, so previous discovery results are no longer valid.
  deps.cfg.vault.on("unlocked", () => { invalidateModelCache(); invalidateVoiceCache(); });
  deps.cfg.vault.on("locked", () => { invalidateModelCache(); invalidateVoiceCache(); });

  /**
   * GET /api/providers — the one endpoint the UI needs for settings,
   * setup wizard, model selector, and voice config.
   */
  app.get("/api/providers", async (_req: Request, res: Response) => {
    const vaultUnlocked = deps.cfg.vault.isUnlocked();

    // Discover models + voice catalog for all configured providers in parallel.
    const providerResults = await Promise.all(
      PROVIDER_CATALOG.map(async (p) => {
        const configured = isConfigured(p, deps);
        const apiKey = getApiKey(p, deps);
        const baseUrl = getBaseUrl(p, deps);

        // LLM models: live if configured, static fallback on empty/failure.
        let discovered = configured
          ? await discoverModelsForProvider(p.id, apiKey, baseUrl)
          : [];
        if (discovered.length === 0 && p.models.length > 0) {
          discovered = p.models.map((m) => ({ id: m.id, name: m.name }));
        }

        // Voice catalog: only fetch if provider has voice capabilities
        // AND is configured. Otherwise fall back to the static seed so
        // the UI can still render *something* for unconfigured providers.
        const hasVoice = p.capabilities.includes("stt") || p.capabilities.includes("tts");
        const voice = hasVoice && configured
          ? await discoverVoiceCatalog(p.id, apiKey, baseUrl)
          : { sttModels: [], ttsModels: [], ttsVoices: [] };

        const sttModels = voice.sttModels.length > 0
          ? voice.sttModels
          : (p.sttModels ?? []).map((m) => ({ id: m.id, name: m.name }));
        const ttsModels = voice.ttsModels.length > 0
          ? voice.ttsModels
          : (p.ttsModels ?? []).map((m) => ({ id: m.id, name: m.name }));
        const ttsVoices = voice.ttsVoices.length > 0
          ? voice.ttsVoices
          : (p.ttsVoices ?? []).map((v) => ({ id: v.id, name: v.name }));

        // Image / video — static catalogs only. No live discovery
        // endpoint exists for image-gen catalogs across the providers
        // we support, so the seed in providers.ts is the source of truth.
        const imageModels = (p.imageModels ?? []).map((m) => ({ id: m.id, name: m.name }));
        const videoModels = (p.videoModels ?? []).map((m) => ({ id: m.id, name: m.name }));

        // Per-capability defaults — sourced from the catalog (first entry
        // of each list, or the explicit `defaultXxx` field). The UI uses
        // these to pre-fill the picker when a user first enables the
        // provider, so we don't fall back to "voice is required" 400s.
        const defaultLlmModel = defaultModelFor(p);
        const defaultStt = defaultSttModelFor(p);
        const defaultTts = defaultTtsModelFor(p);
        const defaultVoice = defaultTtsVoiceFor(p);
        const defaultImg = defaultImageModelFor(p);
        const defaultVid = defaultVideoModelFor(p);

        return {
          id: p.id,
          name: p.name,
          capabilities: p.capabilities,
          configured,
          models: discovered.map((m) => ({
            id: `${p.id}:${m.id}`,
            name: m.name,
            ownedBy: m.ownedBy,
          })),
          ...(sttModels.length ? { sttModels } : {}),
          ...(ttsModels.length ? { ttsModels } : {}),
          ...(ttsVoices.length ? { ttsVoices } : {}),
          ...(imageModels.length ? { imageModels } : {}),
          ...(videoModels.length ? { videoModels } : {}),
          defaults: {
            ...(defaultLlmModel ? { model: defaultLlmModel } : {}),
            ...(defaultStt ? { sttModel: defaultStt } : {}),
            ...(defaultTts ? { ttsModel: defaultTts } : {}),
            ...(defaultVoice ? { ttsVoice: defaultVoice } : {}),
            ...(defaultImg ? { imageModel: defaultImg } : {}),
            ...(defaultVid ? { videoModel: defaultVid } : {}),
          },
        };
      }),
    );

    // Active user selections.
    const defaultModel = deps.cfg.setting("DEFAULT_MODEL");
    const sttProvider = deps.cfg.settings.getGeneric("DAEMORA_STT_PROVIDER") as string | undefined;
    const sttModel = deps.cfg.settings.getGeneric("STT_MODEL") as string | undefined;
    const ttsProvider = deps.cfg.settings.getGeneric("DAEMORA_TTS_PROVIDER") as string | undefined;
    const ttsModel = deps.cfg.settings.getGeneric("TTS_MODEL") as string | undefined;
    const ttsVoice = deps.cfg.settings.getGeneric("TTS_VOICE") as string | undefined;
    const imageGenModel = deps.cfg.setting("IMAGE_GEN_MODEL");
    const videoGenModel = deps.cfg.setting("VIDEO_GEN_MODEL");

    res.json({
      providers: providerResults,
      active: {
        llm: defaultModel ? parseModelId(defaultModel) : null,
        stt: sttProvider ? { provider: sttProvider, model: sttModel ?? null } : null,
        tts: ttsProvider ? { provider: ttsProvider, model: ttsModel ?? null, voice: ttsVoice ?? null } : null,
        image: imageGenModel ? parseModelId(imageGenModel) : null,
        video: videoGenModel ? parseModelId(videoGenModel) : null,
      },
      vault: { exists: deps.cfg.vault.exists(), unlocked: vaultUnlocked },
    });
  });

  /**
   * GET /api/providers/:id/models — force-refresh for a single provider.
   */
  app.get("/api/providers/:id/models", async (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const def = PROVIDERS_BY_ID.get(id);
    if (!def) return res.status(404).json({ error: `Unknown provider: ${id}` });

    const apiKey = getApiKey(def, deps);
    const baseUrl = getBaseUrl(def, deps);

    // Force cache invalidation for this provider.
    const { invalidateProvider } = await import("../../models/discovery.js");
    invalidateProvider(id);

    const models = await discoverModelsForProvider(id, apiKey, baseUrl);
    res.json({
      provider: id,
      configured: isConfigured(def, deps),
      models: models.map((m) => ({ id: `${id}:${m.id}`, name: m.name, ownedBy: m.ownedBy })),
    });
  });

  // ── Backwards-compat: /api/models for existing UI code ────────

  app.get("/api/models", async (_req: Request, res: Response) => {
    const available = await getAllConfiguredModels(deps);
    res.json({
      default: deps.cfg.setting("DEFAULT_MODEL"),
      available,
      models: available,
    });
  });

  app.get("/api/models/all", async (_req: Request, res: Response) => {
    const all = await getAllModels(deps);
    res.json({ models: all });
  });
}

// ── Helpers ─────────────────────────────────────────────────────

function isConfigured(p: ProviderDef, deps: ServerDeps): boolean {
  if (!p.secretKey) return true;
  if (!deps.cfg.vault.isUnlocked()) return false;
  return deps.cfg.vault.has(p.secretKey);
}

function getApiKey(p: ProviderDef, deps: ServerDeps): string | undefined {
  if (!p.secretKey || !deps.cfg.vault.isUnlocked()) return undefined;
  return deps.cfg.vault.get(p.secretKey)?.reveal();
}

function getBaseUrl(p: ProviderDef, deps: ServerDeps): string | undefined {
  if (!p.baseUrlSetting) return p.defaultBaseUrl;
  const custom = deps.cfg.settings.getGeneric(p.baseUrlSetting) as string | undefined;
  return custom ?? p.defaultBaseUrl;
}

/** All models from configured providers only. Falls back to static catalog on discovery failure. */
async function getAllConfiguredModels(deps: ServerDeps): Promise<ModelListEntry[]> {
  const results: ModelListEntry[] = [];
  await Promise.all(
    PROVIDER_CATALOG.filter((p) => isConfigured(p, deps) && p.capabilities.includes("llm")).map(async (p) => {
      let models = await discoverModelsForProvider(p.id, getApiKey(p, deps), getBaseUrl(p, deps));
      if (models.length === 0 && p.models.length > 0) {
        models = p.models.map((m) => ({ id: m.id, name: m.name }));
      }
      for (const m of models) {
        results.push({ id: `${p.id}:${m.id}`, provider: p.id, name: m.name, model: m.id, available: true });
      }
    }),
  );
  return results;
}

/** All models across all providers, with availability flag. */
async function getAllModels(deps: ServerDeps): Promise<ModelListEntry[]> {
  const results: ModelListEntry[] = [];
  await Promise.all(
    PROVIDER_CATALOG.filter((p) => p.capabilities.includes("llm")).map(async (p) => {
      const configured = isConfigured(p, deps);
      let models = configured
        ? await discoverModelsForProvider(p.id, getApiKey(p, deps), getBaseUrl(p, deps))
        : [];
      // Fall back to static catalog if discovery returned empty.
      if (models.length === 0 && p.models.length > 0) {
        models = staticFallback(p);
      }
      for (const m of models) {
        results.push({ id: `${p.id}:${m.id}`, provider: p.id, name: m.name, model: m.id, available: configured });
      }
    }),
  );
  return results;
}

/** For unconfigured providers, show their static catalog so "All" tab isn't empty. */
function staticFallback(p: ProviderDef): DiscoveredModel[] {
  return p.models.map((m) => ({ id: m.id, name: m.name }));
}

function parseModelId(id: string): { provider: string; model: string } | null {
  const i = id.indexOf(":");
  if (i <= 0) return null;
  return { provider: id.slice(0, i), model: id.slice(i + 1) };
}

interface ModelListEntry {
  id: string;
  provider: string;
  name: string;
  model: string;
  available: boolean;
}
