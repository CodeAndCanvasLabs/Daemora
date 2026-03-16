/**
 * TelephonyAudio — PCM ↔ G.711 mu-law codec + resampling.
 *
 * Telephony standard: 8kHz mono G.711 mu-law (64kbps).
 * OpenAI TTS outputs: PCM 24kHz 16-bit mono.
 * OpenAI Realtime STT accepts: G.711 mu-law 8kHz.
 * Twilio media stream sends/receives: G.711 mu-law 8kHz base64 frames (160 bytes = 20ms).
 */

const BIAS = 132;
const CLIP = 32635;
const CHUNK_SIZE = 160; // 20ms @ 8kHz mu-law

// ── PCM ↔ Mu-law ──────────────────────────────────────────────────────────────

function linearToMulaw(sample) {
  const sign = sample < 0 ? 0x80 : 0;
  let s = Math.abs(sample);
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; exponent--) {
    expMask >>= 1;
  }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function mulawToLinear(mulaw) {
  const m = ~mulaw & 0xff;
  const sign = m & 0x80;
  const exponent = (m >> 4) & 0x07;
  const mantissa = m & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign ? -sample : sample;
}

/**
 * Convert 16-bit PCM Buffer → mu-law Buffer (2:1 compression).
 * @param {Buffer} pcmBuf — PCM 16-bit LE mono
 * @returns {Buffer} mu-law
 */
export function pcmToMulaw(pcmBuf) {
  const out = Buffer.alloc(pcmBuf.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = linearToMulaw(pcmBuf.readInt16LE(i * 2));
  }
  return out;
}

/**
 * Convert mu-law Buffer → 16-bit PCM Buffer (1:2 expansion).
 * @param {Buffer} mulawBuf
 * @returns {Buffer} PCM 16-bit LE mono
 */
export function mulawToPcm(mulawBuf) {
  const out = Buffer.alloc(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    out.writeInt16LE(mulawToLinear(mulawBuf[i]), i * 2);
  }
  return out;
}

// ── Resampling ────────────────────────────────────────────────────────────────

/**
 * Resample PCM 16-bit mono buffer from one rate to another.
 * Linear interpolation — simple, deterministic, no external deps.
 * @param {Buffer} input — PCM 16-bit LE
 * @param {number} fromRate — e.g. 24000
 * @param {number} toRate — e.g. 8000
 * @returns {Buffer} resampled PCM 16-bit LE
 */
export function resamplePcm(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const inputSamples = input.length / 2;
  const outputSamples = Math.round(inputSamples * toRate / fromRate);
  const out = Buffer.alloc(outputSamples * 2);
  const ratio = fromRate / toRate;

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;
    const s0 = srcIdx < inputSamples ? input.readInt16LE(srcIdx * 2) : 0;
    const s1 = (srcIdx + 1) < inputSamples ? input.readInt16LE((srcIdx + 1) * 2) : s0;
    const sample = Math.round(s0 + frac * (s1 - s0));
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }
  return out;
}

/**
 * Convert PCM at any rate to mu-law 8kHz (Twilio telephony format).
 * @param {Buffer} pcmBuf — PCM 16-bit LE
 * @param {number} sampleRate — input sample rate (e.g. 24000, 16000)
 * @returns {Buffer} mu-law 8kHz
 */
export function pcmToMulaw8k(pcmBuf, sampleRate) {
  const resampled = resamplePcm(pcmBuf, sampleRate, 8000);
  return pcmToMulaw(resampled);
}

// ── Chunking ──────────────────────────────────────────────────────────────────

/**
 * Split a Buffer into fixed-size chunks.
 * @param {Buffer} buf
 * @param {number} chunkSize — bytes per chunk (default 160 = 20ms mu-law)
 * @returns {Buffer[]}
 */
export function chunkBuffer(buf, chunkSize = CHUNK_SIZE) {
  const chunks = [];
  for (let i = 0; i < buf.length; i += chunkSize) {
    chunks.push(buf.subarray(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Sleep for N milliseconds.
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
