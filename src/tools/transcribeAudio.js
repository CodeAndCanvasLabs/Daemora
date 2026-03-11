/**
 * transcribeAudio(audioPath, prompt?) - Transcribe audio/voice files to text using OpenAI Whisper.
 *
 * Supports: local file paths and HTTPS URLs.
 * Formats: mp3, mp4, mpeg, mpga, m4a, wav, webm, ogg, oga, flac
 *
 * Used by channels to convert voice messages to text before processing as tasks.
 * Can also be called directly by the agent to transcribe any audio file.
 */
import { createReadStream, writeFileSync, existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import OpenAI from "openai";
import filesystemGuard from "../safety/FilesystemGuard.js";
import { getTenantTmpDir } from "./_paths.js";
import tenantContext from "../tenants/TenantContext.js";

const SUPPORTED_EXTENSIONS = new Set([
  ".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm", ".ogg", ".oga", ".flac"
]);

// Telegram voices come as .oga (ogg audio) - map to .ogg for Whisper compatibility
const EXT_REMAP = { ".oga": ".ogg" };

export async function transcribeAudio(params) {
  const audioPath = params?.audioPath;
  const prompt = params?.prompt;
  try {
    if (!audioPath) return "Error: audioPath is required";

    const _store = tenantContext.getStore();
    const _keys = _store?.apiKeys || {};
    const apiKey = _keys.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return "Error: transcribeAudio requires OPENAI_API_KEY (uses OpenAI Whisper API)";
    }

    let localPath = audioPath;

    // Download if URL
    if (audioPath.startsWith("https://") || audioPath.startsWith("http://")) {
      const ext = extname(new URL(audioPath).pathname) || ".ogg";
      const tmpPath = join(getTenantTmpDir("daemora-audio"), `audio-${Date.now()}${ext}`);

      const res = await fetch(audioPath, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) return `Error downloading audio: HTTP ${res.status}`;

      const buffer = await res.arrayBuffer();
      writeFileSync(tmpPath, Buffer.from(buffer));
      localPath = tmpPath;
    }

    // Guard read access for local files (not downloaded URLs — those are already in tenant workspace)
    if (!audioPath.startsWith("http")) {
      const rc = filesystemGuard.checkRead(localPath);
      if (!rc.allowed) return `Error: ${rc.reason}`;
    }

    if (!existsSync(localPath)) {
      return `Error: Audio file not found: ${localPath}`;
    }

    let ext = extname(localPath).toLowerCase();
    // Remap extensions Whisper doesn't recognise
    if (EXT_REMAP[ext]) {
      ext = EXT_REMAP[ext];
    }

    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return `Error: Unsupported audio format: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`;
    }

    const openai = new OpenAI({ apiKey });

    const transcription = await openai.audio.transcriptions.create({
      file: createReadStream(localPath),
      model: "whisper-1",
      prompt: prompt || undefined,   // optional context hint
      response_format: "text",
    });

    // transcription is a string when response_format is "text"
    const text = typeof transcription === "string"
      ? transcription.trim()
      : (transcription.text || "").trim();

    if (!text) return "Transcription returned empty - audio may be silent or too short.";
    return text;

  } catch (error) {
    return `Error transcribing audio: ${error.message}`;
  }
}

export const transcribeAudioDescription =
  'transcribeAudio(audioPath: string, prompt?: string) - Transcribe a voice/audio file to text using OpenAI Whisper. audioPath: local file path or HTTPS URL. Formats: mp3, mp4, m4a, wav, webm, ogg, flac. Requires OPENAI_API_KEY.';
