import { z } from "zod";

import type { ConfigManager } from "../../config/ConfigManager.js";
import { transcribeAudioFile } from "../../voice/transcribe.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  audioPath: z.string().min(1).describe("Path to audio file (mp3, wav, m4a, webm, ogg)."),
  prompt: z.string().optional().describe("Optional context hint to improve accuracy."),
  language: z.string().optional().describe("ISO 639-1 language code (e.g. 'en')."),
});

export function makeTranscribeAudioTool(cfg: ConfigManager): ToolDef<typeof inputSchema, { text: string }> {
  return {
    name: "transcribe_audio",
    description: "Transcribe audio to text using Whisper (via Groq or OpenAI). Prefers Groq (fast + free).",
    category: "ai",
    source: { kind: "core" },
    alwaysOn: false,
    tags: ["audio", "transcribe", "whisper", "speech"],
    inputSchema,
    async execute({ audioPath, prompt, language }, { abortSignal }) {
      const result = await transcribeAudioFile(cfg, audioPath, {
        ...(prompt ? { prompt } : {}),
        ...(language ? { language } : {}),
        signal: abortSignal,
      });
      return { text: result.text };
    },
  };
}
