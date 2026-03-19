/**
 * transcribeAudio(audioPath, prompt?, provider?) - Transcribe audio/voice files to text.
 *
 * Providers (auto-detected, cheapest first):
 *   1. Groq (free) → whisper-large-v3-turbo
 *   2. OpenAI      → whisper-1 / gpt-4o-mini-transcribe
 *
 * Supports: local file paths and HTTPS URLs.
 * Formats: mp3, mp4, mpeg, mpga, m4a, wav, webm, ogg, oga, flac
 */
import { createReadStream, writeFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import filesystemGuard from "../safety/FilesystemGuard.js";
import { getTenantTmpDir } from "./_paths.js";
import tenantContext from "../tenants/TenantContext.js";

const SUPPORTED_EXTENSIONS = new Set([
  ".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm", ".ogg", ".oga", ".flac"
]);

const EXT_REMAP = { ".oga": ".ogg" };

export async function transcribeAudio(params) {
  const audioPath = params?.audioPath;
  const prompt = params?.prompt;
  const providerOverride = params?.provider;
  const modelOverride = params?.model || process.env.STT_MODEL;

  try {
    if (!audioPath) return "Error: audioPath is required";

    const _store = tenantContext.getStore();
    const _keys = _store?.apiKeys || {};

    // Resolve provider: explicit > auto-detect cheapest
    const groqKey = _keys.GROQ_API_KEY || process.env.GROQ_API_KEY;
    const openaiKey = _keys.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

    let provider = providerOverride;
    if (!provider) {
      if (groqKey) provider = "groq";
      else if (openaiKey) provider = "openai";
      else return "Error: transcribeAudio requires GROQ_API_KEY or OPENAI_API_KEY";
    }

    // Download if URL
    let localPath = audioPath;
    if (audioPath.startsWith("https://") || audioPath.startsWith("http://")) {
      const ext = extname(new URL(audioPath).pathname) || ".ogg";
      const tmpPath = join(getTenantTmpDir("daemora-audio"), `audio-${Date.now()}${ext}`);
      const res = await fetch(audioPath, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) return `Error downloading audio: HTTP ${res.status}`;
      writeFileSync(tmpPath, Buffer.from(await res.arrayBuffer()));
      localPath = tmpPath;
    }

    // Guard read access
    if (!audioPath.startsWith("http")) {
      const rc = filesystemGuard.checkRead(localPath);
      if (!rc.allowed) return `Error: ${rc.reason}`;
    }

    if (!existsSync(localPath)) return `Error: Audio file not found: ${localPath}`;

    let ext = extname(localPath).toLowerCase();
    if (EXT_REMAP[ext]) ext = EXT_REMAP[ext];
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return `Error: Unsupported audio format: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`;
    }

    // Dispatch to provider
    if (provider === "groq") {
      return await _groqSTT(localPath, groqKey, prompt, modelOverride);
    } else {
      return await _openaiSTT(localPath, openaiKey, prompt, modelOverride);
    }

  } catch (error) {
    return `Error transcribing audio: ${error.message}`;
  }
}

// ── Groq STT (free tier) ────────────────────────────────────────────────────

async function _groqSTT(localPath, apiKey, prompt, model) {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({
    apiKey,
    baseURL: "https://api.groq.com/openai/v1",
  });

  const transcription = await client.audio.transcriptions.create({
    file: createReadStream(localPath),
    model: model || "whisper-large-v3-turbo",
    prompt: prompt || undefined,
    response_format: "text",
  });

  const text = typeof transcription === "string" ? transcription.trim() : (transcription.text || "").trim();
  if (!text) return "Transcription returned empty - audio may be silent or too short.";
  return text;
}

// ── OpenAI STT ──────────────────────────────────────────────────────────────

async function _openaiSTT(localPath, apiKey, prompt, model) {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const transcription = await client.audio.transcriptions.create({
    file: createReadStream(localPath),
    model: model || "whisper-1",
    prompt: prompt || undefined,
    response_format: "text",
  });

  const text = typeof transcription === "string" ? transcription.trim() : (transcription.text || "").trim();
  if (!text) return "Transcription returned empty - audio may be silent or too short.";
  return text;
}

export const transcribeAudioDescription =
  'transcribeAudio(audioPath, prompt?, provider?, model?) - Transcribe audio to text. ' +
  'Auto-detects cheapest: Groq (free, whisper-large-v3-turbo) → OpenAI (whisper-1). ' +
  'Formats: mp3, mp4, m4a, wav, webm, ogg, flac. ' +
  'Options: {"provider":"groq|openai","model":"whisper-large-v3-turbo|whisper-large-v3|whisper-1|gpt-4o-mini-transcribe"}';
