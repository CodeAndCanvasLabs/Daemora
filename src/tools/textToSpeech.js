/**
 * textToSpeech(text, optionsJson?) - Convert text to speech audio file.
 *
 * Providers (priority):
 *   1. OpenAI   — gpt-4o-mini-tts (default), tts-1, tts-1-hd. 14 voices. Requires OPENAI_API_KEY.
 *   2. ElevenLabs — highest quality, voice cloning. Requires ELEVENLABS_API_KEY.
 *   3. Edge TTS — Microsoft Edge free TTS. No API key. Works offline-ish. Fallback for everyone.
 *
 * Model configurable via TTS_MODEL setting (SQLite/env).
 * Auto-splits text > 4096 chars at sentence boundaries.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import filesystemGuard from "../safety/FilesystemGuard.js";
import { getTenantTmpDir } from "./_paths.js";
import tenantContext from "../tenants/TenantContext.js";
import { mergeLegacyOptions as _mergeLegacyOpts } from "../utils/mergeToolParams.js";

const OPENAI_CHAR_LIMIT = 4096;
const ELEVENLABS_CHAR_LIMIT = 5000;

export async function textToSpeech(params) {
  const text = params?.text;
  try {
    if (!text || text.trim().length === 0) return "Error: text is required";

    const opts = _mergeLegacyOpts(params, ["text"]);
    const provider = (opts.provider || "auto").toLowerCase();

    const _store = tenantContext.getStore();
    const _keys = _store?.apiKeys || {};
    const hasOpenAI = _keys.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    const hasElevenLabs = _keys.ELEVENLABS_API_KEY || process.env.ELEVENLABS_API_KEY;

    // Explicit provider
    if (provider === "elevenlabs") return _elevenLabs(text.trim(), opts);
    if (provider === "openai") return hasOpenAI ? _openAI(text.trim(), opts) : "Error: OPENAI_API_KEY required";
    if (provider === "edge") return _edgeTTS(text.trim(), opts);

    // Explicit provider
    if (provider === "groq") return _groqTTS(text.trim(), opts);

    // Auto: cheapest available. Groq (free) → Edge (free) → OpenAI → ElevenLabs
    const hasGroq = _keys.GROQ_API_KEY || process.env.GROQ_API_KEY;
    if (hasGroq) return _groqTTS(text.trim(), opts);
    if (hasOpenAI) return _openAI(text.trim(), opts);
    if (hasElevenLabs) return _elevenLabs(text.trim(), opts);
    return _edgeTTS(text.trim(), opts);
  } catch (err) {
    return `Error in textToSpeech: ${err.message}`;
  }
}

// ── OpenAI TTS ────────────────────────────────────────────────────────────────

async function _openAI(text, opts) {
  const store = tenantContext.getStore();
  const apiKeys = store?.apiKeys || {};
  const apiKey = apiKeys.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return "Error: OPENAI_API_KEY required";

  const { default: OpenAI } = await import("openai");
  // Custom base URL for local TTS servers (Kokoro, LocalAI, etc.)
  const baseURL = process.env.OPENAI_TTS_BASE_URL || undefined;
  const client = new OpenAI({ apiKey, ...(baseURL && { baseURL }) });

  // Model from settings (SQLite) → opts → default
  const model = opts.model || process.env.TTS_MODEL || "gpt-4o-mini-tts";
  const voice = opts.voice || "nova";
  const speed = Math.max(0.25, Math.min(4.0, parseFloat(opts.speed || "1.0")));
  const format = opts.format || "mp3";

  // gpt-4o-mini-tts supports instructions for tone/style control
  const instructions = opts.instructions || null;

  const ttsDir = getTenantTmpDir("daemora-tts");
  const chunks = _splitText(text, OPENAI_CHAR_LIMIT);

  const paths = [];
  for (let i = 0; i < chunks.length; i++) {
    const createOpts = { model, voice, input: chunks[i], speed, response_format: format };
    if (instructions && model === "gpt-4o-mini-tts") createOpts.instructions = instructions;

    const response = await client.audio.speech.create(createOpts);
    const suffix = chunks.length > 1 ? `-part${i + 1}` : "";
    const filePath = join(ttsDir, `speech-${Date.now()}${suffix}.${format}`);
    writeFileSync(filePath, Buffer.from(await response.arrayBuffer()));
    paths.push(filePath);
  }

  if (paths.length === 1) return `Audio saved to: ${paths[0]}`;
  return `Text split into ${paths.length} files:\n${paths.join("\n")}`;
}

// ── ElevenLabs TTS ────────────────────────────────────────────────────────────

async function _elevenLabs(text, opts) {
  const store = tenantContext.getStore();
  const tenantKeys = store?.apiKeys || {};
  const apiKey = tenantKeys.ELEVENLABS_API_KEY || process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return "Error: ELEVENLABS_API_KEY required";

  const voiceId = opts.voiceId || "21m00Tcm4TlvDq8ikWAM"; // Rachel
  const modelId = opts.modelId || "eleven_multilingual_v2";
  const stability = parseFloat(opts.stability || "0.5");
  const similarityBoost = parseFloat(opts.similarityBoost || "0.75");

  const chunk = text.slice(0, ELEVENLABS_CHAR_LIMIT);

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
    return `Error: ElevenLabs HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`;
  }

  const ttsDir = getTenantTmpDir("daemora-tts");
  const filePath = join(ttsDir, `speech-eleven-${Date.now()}.mp3`);
  writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
  return `Audio saved to: ${filePath}`;
}

// ── Groq TTS (free tier, OpenAI-compatible) ──────────────────────────────────

async function _groqTTS(text, opts) {
  const store = tenantContext.getStore();
  const apiKeys = store?.apiKeys || {};
  const apiKey = apiKeys.GROQ_API_KEY || process.env.GROQ_API_KEY;
  if (!apiKey) return "Error: GROQ_API_KEY required";

  const model = opts.model || process.env.TTS_GROQ_MODEL || "canopylabs/orpheus-v1-english";
  const voice = opts.voice || "tara";
  const format = opts.format || "wav";

  const res = await fetch("https://api.groq.com/openai/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: text.slice(0, 4096),
      voice,
      response_format: format,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return `Error: Groq TTS HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`;
  }

  const ttsDir = getTenantTmpDir("daemora-tts");
  const filePath = join(ttsDir, `speech-groq-${Date.now()}.${format}`);
  writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
  return `Audio saved to: ${filePath}`;
}

// ── Edge TTS (free, no API key) ──────────────────────────────────────────────

async function _edgeTTS(text, opts) {
  try {
    const { EdgeTTS } = await import("edge-tts-universal");
    const tts = new EdgeTTS();

    const voice = opts.voice || "en-US-JennyNeural"; // clear female voice
    const rate = opts.speed ? `${(parseFloat(opts.speed) - 1) * 100}%` : "+0%";

    await tts.synthesize(text.slice(0, 5000), voice, { rate });

    const ttsDir = getTenantTmpDir("daemora-tts");
    const filePath = join(ttsDir, `speech-edge-${Date.now()}.mp3`);
    const audioBuffer = await tts.toBuffer();
    writeFileSync(filePath, audioBuffer);

    return `Audio saved to: ${filePath}`;
  } catch (e) {
    return `Error: Edge TTS failed: ${e.message}. Install: pnpm add edge-tts-universal`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _splitText(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) { chunks.push(remaining); break; }
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
  'textToSpeech(text, optionsJson?) - Convert text to audio. ' +
  'Providers: Groq (free), Edge TTS (free, no key), OpenAI (gpt-4o-mini-tts), ElevenLabs (voice cloning). ' +
  'Options: {"voice":"nova|alloy|ash|coral|echo|fable|shimmer","speed":1.0,"format":"mp3","provider":"groq|openai|elevenlabs|edge","instructions":"speak cheerfully"}. ' +
  'Auto-detects cheapest: Groq (free) → Edge TTS (free) → OpenAI → ElevenLabs. Chain with sendFile() to deliver.';
