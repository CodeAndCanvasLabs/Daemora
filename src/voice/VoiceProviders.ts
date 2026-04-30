/**
 * Voice provider factories — build LiveKit STT + TTS plugin instances
 * from the user's Settings (provider id, model id, voice id, API key).
 *
 * The Settings UI writes these keys:
 *   DAEMORA_STT_PROVIDER   groq | openai | deepgram
 *   STT_MODEL              whisper-large-v3-turbo, nova-3, whisper-1, ...
 *   DAEMORA_TTS_PROVIDER   openai | groq | cartesia | elevenlabs
 *   TTS_MODEL              gpt-4o-mini-tts | canopylabs/orpheus-v1-english | sonic-3 | eleven_turbo_v2_5 | ...
 *   TTS_VOICE              provider-specific voice id / name
 *
 * Secrets live in the vault keyed by provider (e.g. OPENAI_API_KEY,
 * GROQ_API_KEY, DEEPGRAM_API_KEY, CARTESIA_API_KEY, ELEVENLABS_API_KEY).
 *
 * Nothing about provider names or models is hardcoded at call sites —
 * this is the single place where provider string → LiveKit plugin
 * instance mapping lives. Adding a new provider means editing this
 * file and nowhere else.
 */

import type { stt, tts } from "@livekit/agents";

import type { ConfigManager } from "../config/ConfigManager.js";
import {
  PROVIDERS_BY_ID,
  defaultSttModelFor,
  defaultTtsModelFor,
  defaultTtsVoiceFor,
} from "../models/providers.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("voice.providers");

export interface VoicePluginSelection {
  readonly stt: stt.STT;
  readonly tts: tts.TTS;
  readonly sttProvider: string;
  readonly ttsProvider: string;
}

export async function buildVoicePlugins(cfg: ConfigManager): Promise<VoicePluginSelection | null> {
  const sttProvider = getStr(cfg, "DAEMORA_STT_PROVIDER") ?? defaultSttProvider(cfg);
  const ttsProvider = getStr(cfg, "DAEMORA_TTS_PROVIDER") ?? defaultTtsProvider(cfg);

  const sttInst = await buildSTT(cfg, sttProvider);
  if (!sttInst) {
    log.warn({ sttProvider }, "voice: STT provider unavailable");
    return null;
  }
  const ttsInst = await buildTTS(cfg, ttsProvider);
  if (!ttsInst) {
    log.warn({ ttsProvider }, "voice: TTS provider unavailable");
    return null;
  }
  return { stt: sttInst, tts: ttsInst, sttProvider, ttsProvider };
}

// ── STT factory ──────────────────────────────────────────────────

async function buildSTT(cfg: ConfigManager, provider: string): Promise<stt.STT | null> {
  // Settings → catalog default → undefined. The catalog default is sourced
  // from PROVIDER_CATALOG[provider].sttModels[0] in providers.ts — i.e. it's
  // ALREADY in the codebase, not invented.
  const catalogDef = PROVIDERS_BY_ID.get(provider);
  const model = getStr(cfg, "STT_MODEL") ?? (catalogDef ? defaultSttModelFor(catalogDef) : undefined);
  const language = getStr(cfg, "STT_LANGUAGE") ?? "en";

  switch (provider) {
    case "deepgram": {
      const apiKey = readSecret(cfg, "DEEPGRAM_API_KEY");
      if (!apiKey) return null;
      const { STT } = await import("@livekit/agents-plugin-deepgram");
      return new STT({
        apiKey,
        ...(model ? { model } : {}),
        language,
      } as ConstructorParameters<typeof STT>[0]);
    }
    case "groq": {
      const apiKey = readSecret(cfg, "GROQ_API_KEY");
      if (!apiKey) return null;
      const { STT } = await import("@livekit/agents-plugin-openai");
      return STT.withGroq({
        apiKey,
        ...(model ? { model } : {}),
        language,
      });
    }
    case "openai":
    default: {
      const apiKey = readSecret(cfg, "OPENAI_API_KEY");
      if (!apiKey) return null;
      const { STT } = await import("@livekit/agents-plugin-openai");
      return new STT({
        apiKey,
        ...(model ? { model } : {}),
        language,
      });
    }
  }
}

// ── TTS factory ──────────────────────────────────────────────────

async function buildTTS(cfg: ConfigManager, provider: string): Promise<tts.TTS | null> {
  // Settings → catalog default → undefined. Catalog defaults come from
  // PROVIDER_CATALOG[provider].ttsModels[0] / ttsVoices[0] in providers.ts.
  const catalogDef = PROVIDERS_BY_ID.get(provider);
  const model = getStr(cfg, "TTS_MODEL") ?? (catalogDef ? defaultTtsModelFor(catalogDef) : undefined);
  const voice = getStr(cfg, "TTS_VOICE") ?? (catalogDef ? defaultTtsVoiceFor(catalogDef) : undefined);

  switch (provider) {
    case "cartesia": {
      const apiKey = readSecret(cfg, "CARTESIA_API_KEY");
      if (!apiKey) return null;
      const { TTS } = await import("@livekit/agents-plugin-cartesia");
      return new TTS({
        apiKey,
        ...(model ? { model } : {}),
        ...(voice ? { voice } : {}),
      } as ConstructorParameters<typeof TTS>[0]);
    }
    case "elevenlabs": {
      const apiKey = readSecret(cfg, "ELEVENLABS_API_KEY");
      if (!apiKey) return null;
      const { TTS } = await import("@livekit/agents-plugin-elevenlabs");
      return new TTS({
        apiKey,
        ...(model ? { modelId: model } : {}),
        ...(voice ? { voice: { id: voice, name: voice } } : {}),
      } as ConstructorParameters<typeof TTS>[0]);
    }
    case "groq": {
      // Groq speaks OpenAI TTS over an OpenAI-compatible endpoint.
      const apiKey = readSecret(cfg, "GROQ_API_KEY");
      if (!apiKey) return null;
      const { TTS } = await import("@livekit/agents-plugin-openai");
      return new TTS({
        apiKey,
        baseURL: "https://api.groq.com/openai/v1",
        ...(model ? { model } : {}),
        ...(voice ? { voice: voice as never } : {}),
      });
    }
    case "openai":
    default: {
      const apiKey = readSecret(cfg, "OPENAI_API_KEY");
      if (!apiKey) return null;
      const { TTS } = await import("@livekit/agents-plugin-openai");
      return new TTS({
        apiKey,
        ...(model ? { model } : {}),
        ...(voice ? { voice: voice as never } : {}),
      });
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function getStr(cfg: ConfigManager, key: string): string | undefined {
  const v = cfg.settings.getGeneric(key);
  return typeof v === "string" && v ? v : undefined;
}

function readSecret(cfg: ConfigManager, key: string): string | undefined {
  if (cfg.vault.isUnlocked()) {
    const s = cfg.vault.get(key);
    if (s) return s.reveal();
  }
  const g = cfg.settings.getGeneric(key);
  if (typeof g === "string" && g) return g;
  const env = process.env[key];
  return env && env.length > 0 ? env : undefined;
}

/**
 * Fallback provider resolution when the user hasn't explicitly set one.
 * Picks the first provider whose secret is present in the vault.
 */
function defaultSttProvider(cfg: ConfigManager): string {
  if (readSecret(cfg, "DEEPGRAM_API_KEY")) return "deepgram";
  if (readSecret(cfg, "GROQ_API_KEY")) return "groq";
  return "openai";
}
function defaultTtsProvider(cfg: ConfigManager): string {
  if (readSecret(cfg, "CARTESIA_API_KEY")) return "cartesia";
  if (readSecret(cfg, "ELEVENLABS_API_KEY")) return "elevenlabs";
  if (readSecret(cfg, "GROQ_API_KEY")) return "groq";
  return "openai";
}
