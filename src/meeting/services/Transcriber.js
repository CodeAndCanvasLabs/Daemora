/**
 * Transcriber — real-time STT for live meeting audio.
 *
 * Two modes:
 * 1. STREAMING (Deepgram WebSocket) — sub-second latency, speaker diarization
 * 2. FAST BATCH (Whisper/Groq/local) — 3-second chunks, near real-time fallback
 *
 * Priority: Deepgram streaming → OpenAI Whisper → Groq → local Whisper
 */

import { config } from "../../config/default.js";

const SAMPLE_RATE = 16000;

// Configurable via STT_MODEL env/config — default to best available
// Read STT model from config at call time (not import time) — picks up SQLite/vault changes
// Set via: Settings UI, CLI (daemora config set STT_MODEL gpt-4o-transcribe-diarize), or .env
// Options: gpt-4o-mini-transcribe | gpt-4o-transcribe | gpt-4o-transcribe-diarize | whisper-1
function getSTTModel(provider) {
  if (provider === "groq") return process.env.STT_MODEL_GROQ || "whisper-large-v3-turbo";
  return process.env.STT_MODEL || "gpt-4o-mini-transcribe";
}

export default class Transcriber {
  constructor(sessionId, { onTranscript, flushIntervalMs = 3000 } = {}) {
    this.sessionId = sessionId;
    this.onTranscript = onTranscript || (() => {});
    this.flushIntervalMs = flushIntervalMs;
    this.audioBuffer = [];
    this.timer = null;
    this.running = false;
    this.mode = null;
    this._ws = null;
    this._wsReady = false;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
  }

  async start() {
    this.running = true;

    // Try Deepgram streaming first
    if (process.env.DEEPGRAM_API_KEY) {
      await this._startStreaming();
      if (this._wsReady) {
        this.mode = "streaming";
        console.log(`[Transcriber] ${this.sessionId}: STREAMING (Deepgram, sub-second)`);
        return;
      }
    }

    // Fallback: fast batch (3s)
    this.mode = "batch";
    this.timer = setInterval(() => this._flush(), this.flushIntervalMs);
    const provider = process.env.OPENAI_API_KEY ? "Whisper" : process.env.GROQ_API_KEY ? "Groq" : "local";
    console.log(`[Transcriber] ${this.sessionId}: BATCH (${provider}, ${this.flushIntervalMs / 1000}s)`);
  }

  addChunk(float32Data) {
    if (!this.running) return;
    if (this.mode === "streaming" && this._wsReady && this._ws?.readyState === 1) {
      this._ws.send(this._float32ToInt16Buffer(float32Data));
    } else {
      this.audioBuffer.push(float32Data);
    }
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this._ws) {
      try { this._ws.send(JSON.stringify({ type: "CloseStream" })); this._ws.close(); } catch {}
      this._ws = null;
      this._wsReady = false;
    }
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this.mode === "batch") await this._flush();
    console.log(`[Transcriber] ${this.sessionId}: stopped`);
  }

  // ── Deepgram Streaming ──────────────────────────────────────────────────

  async _startStreaming() {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) return;
    try {
      const url = `wss://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true&diarize=true&sample_rate=${SAMPLE_RATE}&channels=1&encoding=linear16&endpointing=300`;
      this._ws = new WebSocket(url, { headers: { Authorization: `Token ${apiKey}` } });

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timeout")), 10000);
        this._ws.onopen = () => { clearTimeout(timeout); this._wsReady = true; this._reconnectAttempts = 0; resolve(); };
        this._ws.onerror = (e) => { clearTimeout(timeout); reject(e); };
        this._ws.onclose = () => { this._wsReady = false; if (this.running) this._reconnect(); };
        this._ws.onmessage = (event) => this._handleDeepgramMessage(event.data);
      });
    } catch (e) {
      console.log(`[Transcriber] Deepgram failed: ${e.message}`);
      this._ws = null;
      this._wsReady = false;
    }
  }

  _handleDeepgramMessage(raw) {
    try {
      const data = JSON.parse(raw);
      if (data.type !== "Results" || !data.is_final) return;
      const alt = data.channel?.alternatives?.[0];
      if (!alt?.transcript?.trim()) return;
      const text = alt.transcript.trim();
      if (text.length < 2) return;

      // Speaker from diarization
      let speaker = "participant";
      const words = alt.words || [];
      if (words.length > 0 && words[0].speaker !== undefined) {
        speaker = `Speaker ${words[0].speaker + 1}`;
      }

      this.onTranscript({ speaker, text, timestamp: Date.now() });
      console.log(`[Transcriber:Live] [${speaker}] "${text.slice(0, 80)}"`);
    } catch {}
  }

  _reconnect() {
    if (!this.running) return;
    this._reconnectAttempts++;
    const delay = Math.min(2000 * Math.pow(1.5, Math.min(this._reconnectAttempts, 10)), 10000);
    console.log(`[Transcriber] Deepgram reconnecting in ${(delay / 1000).toFixed(1)}s`);
    this._reconnectTimer = setTimeout(async () => {
      if (!this.running) return;
      await this._startStreaming();
      if (!this._wsReady) {
        this.mode = "batch";
        this.timer = setInterval(() => this._flush(), this.flushIntervalMs);
      }
    }, delay);
  }

  // ── Fast Batch ──────────────────────────────────────────────────────────

  async _flush() {
    if (this.audioBuffer.length === 0) return;
    const chunks = this.audioBuffer.splice(0);
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
    if (merged.length < SAMPLE_RATE * 0.5) return;

    const wavBuffer = this._float32ToWav(merged);
    try {
      const text = await this._batchTranscribe(wavBuffer);
      if (text?.trim()?.length > 1) {
        this.onTranscript({ speaker: "participant", text: text.trim(), timestamp: Date.now() });
        console.log(`[Transcriber:Batch] "${text.trim().slice(0, 80)}"`);
      }
    } catch (e) {
      console.log(`[Transcriber] batch error: ${e.message}`);
    }
  }

  async _batchTranscribe(wavBuffer) {
    if (process.env.OPENAI_API_KEY) return this._whisperAPI(wavBuffer);
    if (process.env.GROQ_API_KEY) return this._groqAPI(wavBuffer);
    return this._localWhisper(wavBuffer);
  }

  async _whisperAPI(wav) {
    const model = getSTTModel("openai");
    const fd = new FormData();
    fd.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
    fd.append("model", model);
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: fd,
    });
    if (!r.ok) throw new Error(`OpenAI STT (${model}) ${r.status}: ${await r.text().catch(() => "")}`);
    const data = await r.json();

    // gpt-4o-transcribe-diarize returns speaker-attributed segments
    if (data.segments && model.includes("diarize")) {
      for (const seg of data.segments) {
        if (seg.text?.trim()) {
          this.onTranscript({
            speaker: seg.speaker || "participant",
            text: seg.text.trim(),
            timestamp: Date.now(),
          });
        }
      }
      return null; // already emitted via onTranscript
    }

    return data.text;
  }

  async _groqAPI(wav) {
    const model = getSTTModel("groq");
    const fd = new FormData();
    fd.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
    fd.append("model", model);
    const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: fd,
    });
    if (!r.ok) throw new Error(`Groq STT (${model}) ${r.status}: ${await r.text().catch(() => "")}`);
    return (await r.json()).text;
  }

  async _localWhisper(wav) {
    if (!Transcriber._localPipeline) {
      try {
        console.log("[Transcriber] Loading local Whisper (~75MB)...");
        const { pipeline } = await import("@huggingface/transformers");
        Transcriber._localPipeline = await pipeline("automatic-speech-recognition", "onnx-community/whisper-tiny", { dtype: "q8", device: "cpu" });
        console.log("[Transcriber] Local Whisper loaded");
      } catch (e) { console.log(`[Transcriber] Local failed: ${e.message}`); return null; }
    }
    try {
      const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) / 2);
      const f32 = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768.0;
      const r = await Transcriber._localPipeline(f32, { sampling_rate: SAMPLE_RATE, language: "en", task: "transcribe" });
      return r?.text || null;
    } catch (e) { console.log(`[Transcriber] Local error: ${e.message}`); return null; }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  _float32ToInt16Buffer(f32) {
    const buf = Buffer.alloc(f32.length * 2);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7FFF), i * 2);
    }
    return buf;
  }

  _float32ToWav(f32) {
    const ds = f32.length * 2;
    const buf = Buffer.alloc(44 + ds);
    buf.write("RIFF", 0); buf.writeUInt32LE(36 + ds, 4); buf.write("WAVE", 8);
    buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SAMPLE_RATE, 24);
    buf.writeUInt32LE(SAMPLE_RATE * 2, 28); buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(ds, 40);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7FFF), 44 + i * 2);
    }
    return buf;
  }
}

Transcriber._localPipeline = null;
