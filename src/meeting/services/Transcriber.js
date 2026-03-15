/**
 * Transcriber — batch STT service for meeting audio.
 *
 * Priority: OpenAI Whisper API → Groq API → local Whisper (@huggingface/transformers)
 *
 * Accumulates Float32 audio chunks → every N seconds flushes to WAV buffer →
 * sends to STT provider → returns text → calls onTranscript callback.
 *
 * Transcript entries persisted to JSONL file on disk.
 */

import { config } from "../../config/default.js";

const SAMPLE_RATE = 16000;

export default class Transcriber {
  /**
   * @param {string} sessionId
   * @param {object} opts
   * @param {Function} opts.onTranscript — called with {speaker, text, timestamp}
   * @param {number} [opts.flushIntervalMs=10000]
   */
  constructor(sessionId, { onTranscript, flushIntervalMs = 10000 } = {}) {
    this.sessionId = sessionId;
    this.onTranscript = onTranscript || (() => {});
    this.flushIntervalMs = flushIntervalMs;
    this.audioBuffer = [];
    this.timer = null;
    this.running = false;
  }

  /** Start the flush timer */
  start() {
    this.running = true;
    this.timer = setInterval(() => this._flush(), this.flushIntervalMs);
    console.log(`[Transcriber] Started for session ${this.sessionId} (flush every ${this.flushIntervalMs / 1000}s)`);
  }

  /** Add a Float32Array audio chunk */
  addChunk(float32Data) {
    if (!this.running) return;
    this.audioBuffer.push(float32Data);
  }

  /** Stop — flush remaining audio, clear timer */
  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this._flush(); // final flush
    console.log(`[Transcriber] Stopped for session ${this.sessionId}`);
  }

  /** Flush accumulated audio → STT → callback */
  async _flush() {
    if (this.audioBuffer.length === 0) return;

    const chunks = this.audioBuffer.splice(0);

    // Merge into single Float32Array
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    // Skip very short segments (< 0.5s of audio)
    if (merged.length < SAMPLE_RATE * 0.5) return;

    // Convert to WAV buffer
    const wavBuffer = this._float32ToWav(merged);

    try {
      const text = await this._transcribe(wavBuffer);
      if (text && text.trim() && text.trim().length > 1) {
        const entry = { speaker: "participant", text: text.trim(), timestamp: Date.now() };

        // Notify callback — MeetingSessionManager handles persistence to JSONL
        this.onTranscript(entry);

        console.log(`[Transcriber] ${this.sessionId}: "${text.trim().slice(0, 80)}"`);
      }
    } catch (e) {
      console.log(`[Transcriber] STT error: ${e.message}`);
    }
  }

  /** Route to best available STT provider */
  async _transcribe(wavBuffer) {
    if (process.env.OPENAI_API_KEY) return this._whisperAPI(wavBuffer);
    if (process.env.GROQ_API_KEY) return this._groqAPI(wavBuffer);
    return this._localWhisper(wavBuffer);
  }

  /** OpenAI Whisper API */
  async _whisperAPI(wavBuffer) {
    const formData = new FormData();
    formData.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");
    formData.append("model", "whisper-1");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: formData,
    });
    if (!res.ok) throw new Error(`Whisper API ${res.status}`);
    return (await res.json()).text;
  }

  /** Groq Whisper API */
  async _groqAPI(wavBuffer) {
    const formData = new FormData();
    formData.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");
    formData.append("model", "whisper-large-v3");

    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: formData,
    });
    if (!res.ok) throw new Error(`Groq API ${res.status}`);
    return (await res.json()).text;
  }

  /** Local Whisper via @huggingface/transformers (free, no API key, CPU) */
  async _localWhisper(wavBuffer) {
    // Lazy-load pipeline — downloads model on first use (~75MB)
    if (!Transcriber._localPipeline) {
      try {
        console.log("[Transcriber] Loading local Whisper model (first use downloads ~75MB)...");
        const { pipeline } = await import("@huggingface/transformers");
        Transcriber._localPipeline = await pipeline(
          "automatic-speech-recognition",
          "onnx-community/whisper-tiny",
          { dtype: "q8", device: "cpu" }
        );
        console.log("[Transcriber] Local Whisper model loaded");
      } catch (e) {
        console.log(`[Transcriber] Local Whisper failed: ${e.message}. Set OPENAI_API_KEY or GROQ_API_KEY for STT.`);
        return null;
      }
    }

    try {
      // WAV buffer → skip 44-byte header → Int16 PCM → Float32
      const pcmData = new Int16Array(wavBuffer.buffer, wavBuffer.byteOffset + 44, (wavBuffer.length - 44) / 2);
      const float32 = new Float32Array(pcmData.length);
      for (let i = 0; i < pcmData.length; i++) float32[i] = pcmData[i] / 32768.0;

      const result = await Transcriber._localPipeline(float32, {
        sampling_rate: SAMPLE_RATE,
        language: "en",
        task: "transcribe",
      });
      return result?.text || null;
    } catch (e) {
      console.log(`[Transcriber] Local transcription error: ${e.message}`);
      return null;
    }
  }

  /** Convert Float32Array to WAV buffer */
  _float32ToWav(float32Data) {
    const dataSize = float32Data.length * 2;
    const buffer = Buffer.alloc(44 + dataSize);

    // Header
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write("WAVE", 8);
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);        // PCM
    buffer.writeUInt16LE(1, 22);        // mono
    buffer.writeUInt32LE(SAMPLE_RATE, 24);
    buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byteRate
    buffer.writeUInt16LE(2, 32);        // blockAlign
    buffer.writeUInt16LE(16, 34);       // bitsPerSample
    buffer.write("data", 36);
    buffer.writeUInt32LE(dataSize, 40);

    // PCM data
    for (let i = 0; i < float32Data.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Data[i]));
      const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
      buffer.writeInt16LE(Math.round(val), 44 + i * 2);
    }
    return buffer;
  }
}

// Static — shared across all Transcriber instances (singleton model load)
Transcriber._localPipeline = null;
