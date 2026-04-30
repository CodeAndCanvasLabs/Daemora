/**
 * generate_music — provider-agnostic music / audio generation.
 *
 * Tries Suno first (real music API with prompt + duration + lyrics),
 * then falls back to OpenAI TTS voicing the prompt if no music
 * provider is configured. Returns the saved file path.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { ConfigManager } from "../../config/ConfigManager.js";
import type { FilesystemGuard } from "../../safety/FilesystemGuard.js";
import { ProviderError, ProviderUnavailableError, TimeoutError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_MS = 300_000;

const inputSchema = z.object({
  prompt: z.string().min(1).max(1000),
  duration: z.number().int().min(5).max(600).default(30),
  style: z.string().optional(),
  genre: z.string().optional(),
  instrumental: z.boolean().default(true),
  lyrics: z.string().optional(),
  format: z.enum(["mp3", "wav"]).default("mp3"),
  outputPath: z.string().optional(),
});

export function makeGenerateMusicTool(cfg: ConfigManager, guard: FilesystemGuard): ToolDef<typeof inputSchema, unknown> {
  return {
    name: "generate_music",
    description:
      "Generate music or ambient audio from a text prompt. Prefers Suno (real music) and falls back to OpenAI TTS if Suno isn't configured.",
    category: "ai",
    source: { kind: "core" },
    tags: ["music", "audio", "generation", "suno", "tts"],
    inputSchema,
    async execute({ prompt, duration, style, genre, instrumental, lyrics, format, outputPath }, { abortSignal, logger }) {
      const openaiKey = cfg.vault.get("OPENAI_API_KEY")?.reveal();
      const sunoKey = cfg.vault.get("SUNO_API_KEY")?.reveal();
      if (!openaiKey && !sunoKey) {
        throw new ProviderUnavailableError("music generation", "SUNO_API_KEY or OPENAI_API_KEY");
      }

      // Compose a richer prompt.
      const promptParts: string[] = [prompt];
      if (style) promptParts.push(`Style: ${style}`);
      if (genre) promptParts.push(`Genre: ${genre}`);
      if (!instrumental && lyrics) promptParts.push(`Lyrics: ${lyrics}`);
      const fullPrompt = promptParts.join(". ");

      let audio: Buffer | null = null;
      let provider: "suno" | "openai-tts" | null = null;

      // Suno first (actual music).
      if (sunoKey) {
        try {
          audio = await sunoGenerate(sunoKey, fullPrompt, duration, instrumental, lyrics, abortSignal, logger);
          provider = "suno";
        } catch (e) {
          logger.warn("suno music generation failed", { error: (e as Error).message });
        }
      }

      // Fall back to OpenAI TTS voicing the prompt. Not "music" in the
      // Suno sense but usable for narration / ambient cues.
      if (!audio && openaiKey) {
        try {
          audio = await openaiSpeak(openaiKey, fullPrompt, format, abortSignal);
          provider = "openai-tts";
        } catch (e) {
          logger.warn("openai tts fallback failed", { error: (e as Error).message });
        }
      }

      if (!audio || !provider) {
        throw new ProviderError("All music providers failed — check API keys and quotas.", "music");
      }

      const ext = format === "wav" ? ".wav" : ".mp3";
      const dest = outputPath
        ? guard.ensureAllowed(outputPath, "write")
        : await defaultOutputPath(ext);
      await writeFile(dest, audio);
      logger.info("generate_music saved", { path: dest, provider, bytes: audio.length });

      return {
        path: dest,
        provider,
        sizeBytes: audio.length,
        message: `Music saved to ${dest} via ${provider}`,
      };
    },
  };
}

async function sunoGenerate(
  apiKey: string,
  prompt: string,
  duration: number,
  instrumental: boolean,
  lyrics: string | undefined,
  signal: AbortSignal,
  logger: { info: (msg: string, ctx?: object) => void },
): Promise<Buffer> {
  const res = await fetch("https://api.suno.ai/v1/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      prompt,
      duration,
      instrumental,
      ...(lyrics && !instrumental ? { lyrics } : {}),
    }),
    signal,
  });
  if (!res.ok) throw new ProviderError(`Suno ${res.status}: ${await res.text().catch(() => "")}`, "suno");
  const data = (await res.json()) as { id?: string; audio_url?: string };

  // Immediate audio URL.
  if (data.audio_url) {
    const dl = await fetch(data.audio_url, { signal });
    if (!dl.ok) throw new ProviderError(`Suno asset ${dl.status}`, "suno");
    return Buffer.from(await dl.arrayBuffer());
  }

  // Async — poll.
  const taskId = data.id;
  if (!taskId) throw new ProviderError("Suno returned no audio_url or task id", "suno");
  logger.info("suno polling", { taskId });

  const started = Date.now();
  while (Date.now() - started < MAX_POLL_MS) {
    if (signal.aborted) throw new TimeoutError("generate_music cancelled", 0);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollRes = await fetch(`https://api.suno.ai/v1/generate/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` }, signal,
    });
    const pollData = (await pollRes.json()) as { status?: string; audio_url?: string; error?: string };
    if (pollData.audio_url) {
      const dl = await fetch(pollData.audio_url, { signal });
      if (!dl.ok) throw new ProviderError(`Suno asset ${dl.status}`, "suno");
      return Buffer.from(await dl.arrayBuffer());
    }
    if (pollData.status === "failed") {
      throw new ProviderError(`Suno generation failed: ${pollData.error ?? "unknown"}`, "suno");
    }
  }
  throw new TimeoutError(`Suno taskId=${taskId}`, MAX_POLL_MS);
}

async function openaiSpeak(apiKey: string, prompt: string, format: "mp3" | "wav", signal: AbortSignal): Promise<Buffer> {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "tts-1-hd",
      voice: "nova",
      input: `[Music generation] ${prompt}`,
      response_format: format,
    }),
    signal,
  });
  if (!res.ok) throw new ProviderError(`OpenAI TTS ${res.status}`, "openai");
  return Buffer.from(await res.arrayBuffer());
}

async function defaultOutputPath(ext: string): Promise<string> {
  const dir = join(tmpdir(), "daemora-music");
  await mkdir(dir, { recursive: true });
  return join(dir, `music-${Date.now()}${ext}`);
}
