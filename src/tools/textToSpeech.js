/**
 * textToSpeech(text, optionsJson?) - Convert text to speech and save as audio file.
 *
 * Primary:  OpenAI TTS (tts-1-hd) - uses the same OPENAI_API_KEY already configured.
 * Optional: ElevenLabs via ELEVENLABS_API_KEY (higher quality, more voices).
 *
 * Unlike OpenClaw's /voice command (config-only, iOS-only), this is a proper
 * agent-callable tool. Chain with sendFile() to deliver audio to the user.
 *
 * OpenAI voices:    alloy, echo, fable, onyx, nova (default), shimmer
 * ElevenLabs:       any voice from your ElevenLabs account, set via voiceId option
 *
 * Auto-splits text > 4096 chars (OpenAI hard limit) into sequential MP3 files.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_DIR = join(tmpdir(), "daemora-tts");
const OPENAI_CHAR_LIMIT = 4096;
const ELEVENLABS_CHAR_LIMIT = 5000;

export async function textToSpeech(text, optionsJson) {
  try {
    if (!text || text.trim().length === 0) {
      return "Error: text is required";
    }

    const opts = optionsJson ? JSON.parse(optionsJson) : {};
    const provider = opts.provider?.toLowerCase() || "openai";

    // Prefer ElevenLabs if key is present and provider not forced
    if (provider === "elevenlabs" || (provider === "auto" && process.env.ELEVENLABS_API_KEY)) {
      return await _elevenLabs(text.trim(), opts);
    }

    return await _openAI(text.trim(), opts);
  } catch (err) {
    return `Error in textToSpeech: ${err.message}`;
  }
}

// ── OpenAI TTS ────────────────────────────────────────────────────────────────

async function _openAI(text, opts) {
  if (!process.env.OPENAI_API_KEY) {
    return "Error: textToSpeech requires OPENAI_API_KEY";
  }

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const voice  = opts.voice  || "nova";    // nova = clear, neutral, works great for most use cases
  const speed  = Math.max(0.25, Math.min(4.0, parseFloat(opts.speed  || "1.0")));
  const format = opts.format || "mp3";     // mp3 | opus | aac | flac
  const model  = opts.hd === false ? "tts-1" : "tts-1-hd"; // tts-1-hd = better quality

  mkdirSync(TMP_DIR, { recursive: true });

  // Split into chunks if text exceeds API limit
  const chunks = _splitText(text, OPENAI_CHAR_LIMIT);

  if (chunks.length === 1) {
    const response = await client.audio.speech.create({ model, voice, input: chunks[0], speed, response_format: format });
    const filePath = join(TMP_DIR, `speech-${Date.now()}.${format}`);
    writeFileSync(filePath, Buffer.from(await response.arrayBuffer()));
    return `Audio saved to: ${filePath}`;
  }

  // Multiple chunks - save each sequentially, return all paths
  const paths = [];
  for (let i = 0; i < chunks.length; i++) {
    const response = await client.audio.speech.create({ model, voice, input: chunks[i], speed, response_format: format });
    const filePath = join(TMP_DIR, `speech-${Date.now()}-part${i + 1}.${format}`);
    writeFileSync(filePath, Buffer.from(await response.arrayBuffer()));
    paths.push(filePath);
  }

  return `Text was split into ${paths.length} audio files:\n${paths.join("\n")}\nUse sendFile() to deliver each one.`;
}

// ── ElevenLabs TTS ────────────────────────────────────────────────────────────

async function _elevenLabs(text, opts) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return "Error: provider=elevenlabs requires ELEVENLABS_API_KEY";
  }

  // Default: Rachel - professional female voice, works well for most content
  const voiceId  = opts.voiceId  || "21m00Tcm4TlvDq8ikWAM";
  const modelId  = opts.modelId  || "eleven_multilingual_v2"; // supports 29 languages
  const stability       = parseFloat(opts.stability       || "0.5");
  const similarityBoost = parseFloat(opts.similarityBoost || "0.75");

  const chunk = text.slice(0, ELEVENLABS_CHAR_LIMIT);
  if (text.length > ELEVENLABS_CHAR_LIMIT) {
    console.log(`[textToSpeech] ElevenLabs: text truncated to ${ELEVENLABS_CHAR_LIMIT} chars`);
  }

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: chunk,
      model_id: modelId,
      voice_settings: { stability, similarity_boost: similarityBoost },
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return `Error: ElevenLabs API returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`;
  }

  mkdirSync(TMP_DIR, { recursive: true });
  const filePath = join(TMP_DIR, `speech-eleven-${Date.now()}.mp3`);
  writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
  return `Audio saved to: ${filePath}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Split text at sentence boundaries to keep chunks under maxLength.
 * Sentence-aware: tries to break at ". ", "? ", "! " before hard-cutting.
 */
function _splitText(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to break at sentence boundary near the limit
    let idx = -1;
    for (const sep of [". ", "? ", "! ", "\n\n", "\n", " "]) {
      const pos = remaining.lastIndexOf(sep, maxLength);
      if (pos > maxLength * 0.5) { idx = pos + sep.length; break; }
    }
    if (idx === -1) idx = maxLength;

    chunks.push(remaining.slice(0, idx).trim());
    remaining = remaining.slice(idx).trimStart();
  }

  return chunks.filter(Boolean);
}

export const textToSpeechDescription =
  'textToSpeech(text: string, optionsJson?: string) - Convert text to an audio file using OpenAI TTS (default) or ElevenLabs. ' +
  'optionsJson: {"voice":"nova|alloy|echo|fable|onyx|shimmer","speed":1.0,"format":"mp3","hd":true,"provider":"openai|elevenlabs","voiceId":"<elevenlabs-id>"}. ' +
  'Requires OPENAI_API_KEY (or ELEVENLABS_API_KEY for ElevenLabs). ' +
  'Auto-splits long texts. Returns the saved file path. Chain with sendFile() to deliver audio to the user.';
