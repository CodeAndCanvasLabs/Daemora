import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

import type { ConfigManager } from "../../config/ConfigManager.js";
import { ProviderUnavailableError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  text: z.string().min(1).max(4096).describe("Text to convert to speech."),
  voice: z.string().default("nova").describe("Voice name (provider-dependent)."),
  outputPath: z.string().optional().describe("Output file path. Defaults to temp."),
  speed: z.number().min(0.25).max(4.0).default(1.0),
});

export function makeTextToSpeechTool(cfg: ConfigManager): ToolDef<typeof inputSchema, { path: string; bytes: number }> {
  return {
    name: "text_to_speech",
    description: "Convert text to audio using the configured TTS provider. Returns path to the generated audio file.",
    category: "ai",
    source: { kind: "core" },
    alwaysOn: false,
    tags: ["tts", "speech", "audio", "voice"],
    inputSchema,
    async execute({ text, voice, outputPath, speed }) {
      const openaiKey = cfg.vault.get("OPENAI_API_KEY")?.reveal();
      const groqKey = cfg.vault.get("GROQ_API_KEY")?.reveal();

      // Honour DAEMORA_TTS_PROVIDER setting (set via Setup wizard / Settings page).
      // Falls back to "whichever key exists, OpenAI preferred" only when the
      // setting is absent.
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

      // Honour TTS_MODEL setting; only fall back to provider defaults when unset.
      // Note: Groq decommissioned `playai-tts`. The current Groq TTS model is
      // `canopylabs/orpheus-v1-english` (Orpheus). OpenAI default stays `tts-1`.
      const settingModel = (cfg.settings.getGeneric("TTS_MODEL") as string | undefined) ?? "";
      const model = settingModel || (isOpenAI ? "tts-1" : "canopylabs/orpheus-v1-english");

      // Provider quirks:
      //   - Groq Orpheus: voice is case-sensitive (lowercase only); response_format
      //     MUST be "wav" (only supported value).
      //   - OpenAI tts-1: accepts mp3/opus/aac/flac/wav, voice is case-insensitive.
      const responseFormat = isOpenAI ? "mp3" : "wav";
      const normalisedVoice = isOpenAI ? voice : voice.toLowerCase();

      const res = await fetch(`${baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: text,
          voice: normalisedVoice,
          speed,
          response_format: responseFormat,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);

      const buffer = Buffer.from(await res.arrayBuffer());
      // If caller asked for `.mp3` but provider only outputs `.wav` (or vice
      // versa), rewrite the extension so the saved file matches its bytes.
      const ext = `.${responseFormat}`;
      let path = outputPath ?? join(tmpdir(), `daemora-tts-${Date.now()}${ext}`);
      if (!path.toLowerCase().endsWith(ext)) {
        path = path.replace(/\.(mp3|wav|opus|aac|flac|m4a)$/i, "") + ext;
      }
      await writeFile(path, buffer);
      return { path, bytes: buffer.length };
    },
  };
}
