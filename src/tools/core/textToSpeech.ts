import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

import type { ConfigManager } from "../../config/ConfigManager.js";
import { ProviderUnavailableError } from "../../util/errors.js";
import { createLogger } from "../../util/logger.js";
import type { ToolDef } from "../types.js";

const log = createLogger("tool.tts");

/** Voice catalogs per provider — kept in lockstep with what the upstream API accepts. */
const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"] as const;
const GROQ_ORPHEUS_VOICES = ["autumn", "diana", "hannah", "austin", "daniel", "troy"] as const;

/** Default voice per provider when the caller doesn't pass one (or passes an unsupported one). */
const OPENAI_DEFAULT_VOICE = "nova";
const GROQ_DEFAULT_VOICE = "diana";

const inputSchema = z.object({
  text: z.string().min(1).max(4096).describe("Text to convert to speech."),
  voice: z
    .string()
    .optional()
    .describe(
      `Voice name. OpenAI: ${OPENAI_VOICES.join("/")}. Groq Orpheus: ${GROQ_ORPHEUS_VOICES.join("/")}. If the value isn't valid for the active provider, the provider's default voice is used.`,
    ),
  outputPath: z.string().optional().describe("Output file path. Defaults to temp."),
  speed: z.number().min(0.25).max(4.0).default(1.0),
});

export function makeTextToSpeechTool(cfg: ConfigManager): ToolDef<typeof inputSchema, { path: string; bytes: number; voice: string; provider: "openai" | "groq" }> {
  return {
    name: "text_to_speech",
    description:
      "Convert text to audio using the configured TTS provider (OpenAI or Groq Orpheus). Returns path to the generated audio file plus the voice/provider used.",
    category: "ai",
    source: { kind: "core" },
    alwaysOn: false,
    tags: ["tts", "speech", "audio", "voice"],
    inputSchema,
    async execute({ text, voice, outputPath, speed }) {
      const openaiKey = cfg.vault.get("OPENAI_API_KEY")?.reveal();
      const groqKey = cfg.vault.get("GROQ_API_KEY")?.reveal();

      const explicitProvider = (cfg.settings.getGeneric("DAEMORA_TTS_PROVIDER") as string | undefined)?.toLowerCase();
      let isOpenAI: boolean;
      if (explicitProvider === "groq") {
        if (!groqKey) throw new ProviderUnavailableError("TTS (groq)", "GROQ_API_KEY");
        isOpenAI = false;
      } else if (explicitProvider === "openai") {
        if (!openaiKey) throw new ProviderUnavailableError("TTS (openai)", "OPENAI_API_KEY");
        isOpenAI = true;
      } else {
        if (!openaiKey && !groqKey) throw new ProviderUnavailableError("TTS", "OPENAI_API_KEY or GROQ_API_KEY");
        isOpenAI = !!openaiKey;
      }

      const apiKey = isOpenAI ? openaiKey! : groqKey!;
      const baseUrl = isOpenAI ? "https://api.openai.com/v1" : "https://api.groq.com/openai/v1";

      const settingModel = (cfg.settings.getGeneric("TTS_MODEL") as string | undefined) ?? "";
      const model = settingModel || (isOpenAI ? "tts-1" : "canopylabs/orpheus-v1-english");

      const responseFormat = isOpenAI ? "mp3" : "wav";

      // Resolve the voice. Priority:
      //   1. `voice` argument from the caller (if valid for the active provider)
      //   2. `TTS_VOICE` setting configured by the user in Settings
      //   3. Provider default (only if neither of the above is valid)
      // The setting is the primary place users express their preference,
      // so a crew passing the OpenAI default `nova` while the user has
      // chosen `troy` for Groq Orpheus must NOT silently downgrade — we
      // honour the setting.
      const allowed = isOpenAI ? OPENAI_VOICES : GROQ_ORPHEUS_VOICES;
      const allowedSet = new Set<string>(allowed);
      const settingVoice = ((cfg.settings.getGeneric("TTS_VOICE") as string | undefined) ?? "").toLowerCase().trim();
      const fallback = isOpenAI ? OPENAI_DEFAULT_VOICE : GROQ_DEFAULT_VOICE;
      const requested = voice ? voice.toLowerCase() : "";

      let resolvedVoice: string;
      let source: "argument" | "setting" | "default";
      if (requested && allowedSet.has(requested)) {
        resolvedVoice = requested;
        source = "argument";
      } else if (settingVoice && allowedSet.has(settingVoice)) {
        resolvedVoice = settingVoice;
        source = "setting";
      } else {
        resolvedVoice = fallback;
        source = "default";
      }

      if (requested && resolvedVoice !== requested) {
        log.warn(
          {
            requested,
            resolved: resolvedVoice,
            source,
            provider: isOpenAI ? "openai" : "groq",
            allowed,
          },
          "tts: requested voice unsupported by active provider — using setting/default",
        );
      }
      // OpenAI voice names are case-insensitive on the wire but their
      // examples use lowercase; Groq Orpheus is strictly lowercase.
      const wireVoice = resolvedVoice;

      const res = await fetch(`${baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: text,
          voice: wireVoice,
          speed,
          response_format: responseFormat,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);

      const buffer = Buffer.from(await res.arrayBuffer());
      const ext = `.${responseFormat}`;
      let path = outputPath ?? join(tmpdir(), `daemora-tts-${Date.now()}${ext}`);
      if (!path.toLowerCase().endsWith(ext)) {
        path = path.replace(/\.(mp3|wav|opus|aac|flac|m4a)$/i, "") + ext;
      }
      await writeFile(path, buffer);
      return { path, bytes: buffer.length, voice: resolvedVoice, provider: isOpenAI ? "openai" : "groq" };
    },
  };
}
