/**
 * TelephonyTTS - TTS synthesis → mu-law 8kHz for Twilio media streams.
 *
 * Provider priority (based on available keys):
 *   1. ElevenLabs (best quality, turbo_v2_5 model)
 *   2. OpenAI gpt-4o-mini-tts (natural, fast)
 *   3. OpenAI tts-1 (fallback)
 *
 * Output: PCM 24kHz → resample → mu-law 8kHz (Twilio telephony format).
 */

import { configStore } from "../config/ConfigStore.js";
import { pcmToMulaw8k } from "../meeting/TelephonyAudio.js";

function conf(key) {
  return process.env[key] || configStore.get(key) || "";
}

/**
 * Synthesize text → mu-law 8kHz Buffer for Twilio.
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.voiceId] - ElevenLabs voice ID or OpenAI voice name
 * @returns {Promise<Buffer>} mu-law 8kHz audio
 */
export async function synthesizeForTelephony(text, opts = {}) {
  const elevenKey = conf("ELEVENLABS_API_KEY");
  const openaiKey = conf("OPENAI_API_KEY");

  // ElevenLabs: best quality
  if (elevenKey) {
    try {
      return await _elevenLabsTTS(text, opts.voiceId, elevenKey);
    } catch (e) {
      console.log(`[TelephonyTTS] ElevenLabs failed: ${e.message} - falling back to OpenAI`);
    }
  }

  // OpenAI TTS
  if (openaiKey) {
    return _openaiTTS(text, opts.voiceId || "coral", openaiKey);
  }

  throw new Error("No TTS API key available (ELEVENLABS_API_KEY or OPENAI_API_KEY required)");
}

async function _elevenLabsTTS(text, voiceId, apiKey) {
  const vid = voiceId || conf("TTS_VOICE") || "cgSgspJ2msm6clMCkdW9"; // Jessica (default)
  const model = conf("TTS_MODEL_ELEVEN") || "eleven_turbo_v2_5";

  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}?output_format=pcm_24000`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`ElevenLabs TTS ${r.status}: ${body.slice(0, 200)}`);
  }

  const pcm = Buffer.from(await r.arrayBuffer());
  return pcmToMulaw8k(pcm, 24000);
}

async function _openaiTTS(text, voice, apiKey) {
  const model = conf("TTS_MODEL") || "gpt-4o-mini-tts";

  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: text,
      voice: voice || "coral",
      response_format: "pcm",
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`OpenAI TTS ${r.status}: ${body.slice(0, 200)}`);
  }

  const pcm = Buffer.from(await r.arrayBuffer());
  // OpenAI PCM response_format is 24kHz
  return pcmToMulaw8k(pcm, 24000);
}
