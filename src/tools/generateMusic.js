/**
 * generateMusic - Generate music/audio using AI providers.
 * Provider-agnostic: supports any API that takes prompt + returns audio.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import filesystemGuard from "../safety/FilesystemGuard.js";
import { getTenantTmpDir } from "./_paths.js";

const POLL_INTERVAL = 5000;
const MAX_POLL_TIME = 300000;

export async function generateMusic(params) {
  const prompt = params?.prompt;
  if (!prompt) return "Error: prompt is required.";

  const {
    duration = 30,
    style = null,
    genre = null,
    instrumental = true,
    lyrics = null,
    format = "mp3",
    outputPath = null,
  } = params;

  // Try providers in order of availability
  const apiKey = process.env.OPENAI_API_KEY;
  const sunoKey = process.env.SUNO_API_KEY;

  if (!apiKey && !sunoKey) {
    return "Error: No music generation API configured. Set OPENAI_API_KEY or SUNO_API_KEY.";
  }

  try {
    // Build enhanced prompt
    const parts = [prompt];
    if (style) parts.push(`Style: ${style}`);
    if (genre) parts.push(`Genre: ${genre}`);
    if (!instrumental && lyrics) parts.push(`Lyrics: ${lyrics}`);
    const fullPrompt = parts.join(". ");

    let audioBuffer;
    let usedProvider;

    // Provider 1: OpenAI Audio (if available)
    if (apiKey) {
      try {
        const res = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: "tts-1-hd",
            voice: "nova",
            input: `[Music generation] ${fullPrompt}`,
            response_format: format === "wav" ? "wav" : "mp3",
          }),
        });

        if (res.ok) {
          audioBuffer = Buffer.from(await res.arrayBuffer());
          usedProvider = "openai-tts";
        }
      } catch {}
    }

    // Provider 2: Suno API
    if (!audioBuffer && sunoKey) {
      try {
        const res = await fetch("https://api.suno.ai/v1/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${sunoKey}` },
          body: JSON.stringify({
            prompt: fullPrompt,
            duration,
            instrumental,
            ...(lyrics && !instrumental ? { lyrics } : {}),
          }),
        });

        if (res.ok) {
          const data = await res.json();

          // Suno is async — poll for completion
          if (data.id) {
            const result = await _pollForCompletion(sunoKey, data.id, "https://api.suno.ai/v1/generate");
            if (result.error) return result.error;
            audioBuffer = result.buffer;
            usedProvider = "suno";
          } else if (data.audio_url) {
            const audioRes = await fetch(data.audio_url);
            audioBuffer = Buffer.from(await audioRes.arrayBuffer());
            usedProvider = "suno";
          }
        }
      } catch {}
    }

    if (!audioBuffer) {
      return "Error: Music generation failed — no provider returned audio. Check your API keys and quotas.";
    }

    // Save to disk
    const dir = getTenantTmpDir("daemora-music");
    const ext = format === "wav" ? ".wav" : ".mp3";
    const filePath = outputPath || join(dir, `music-${Date.now()}${ext}`);

    if (outputPath) {
      const wc = filesystemGuard.checkWrite(outputPath);
      if (!wc.allowed) return `Error: ${wc.reason}`;
    }

    writeFileSync(filePath, audioBuffer);
    console.log(`[generateMusic] Saved: ${filePath} (${usedProvider})`);
    return `Music generated and saved to: ${filePath}\nProvider: ${usedProvider}\nPrompt: "${prompt.slice(0, 100)}"`;
  } catch (err) {
    return `Error generating music: ${err.message}`;
  }
}

async function _pollForCompletion(apiKey, taskId, baseUrl) {
  const startTime = Date.now();
  while (Date.now() - startTime < MAX_POLL_TIME) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    try {
      const res = await fetch(`${baseUrl}/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data = await res.json();
      if (data.status === "completed" || data.audio_url) {
        const audioRes = await fetch(data.audio_url);
        return { buffer: Buffer.from(await audioRes.arrayBuffer()) };
      }
      if (data.status === "failed") return { error: `Error: Music generation failed — ${data.error || "unknown"}` };
    } catch {}
  }
  return { error: `Error: Music generation timed out after ${MAX_POLL_TIME / 1000}s` };
}
