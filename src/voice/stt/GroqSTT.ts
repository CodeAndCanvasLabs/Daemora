/**
 * GroqSTT — batch speech-to-text via Groq's OpenAI-compatible API.
 *
 * NOT streaming. Collects PCM16 audio chunks into a buffer, then
 * transcribes on flush() or when silence is detected (energy-based).
 * Good as a fallback when a streaming provider is unavailable.
 */

import { createLogger } from "../../util/logger.js";
import {
  STTAdapter,
  type STTConfig,
  type TranscriptEvent,
} from "./STTAdapter.js";

const log = createLogger("voice:stt:groq");

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const SILENCE_THRESHOLD_MS = 1000; // 1s silence = user done talking
const ENERGY_FLOOR = 200; // RMS threshold for "silence"

export class GroqSTT extends STTAdapter {
  readonly id = "groq";
  readonly streaming = false;

  private config: STTConfig | null = null;
  private chunks: Buffer[] = [];
  private totalBytes = 0;
  private silenceStart: number | null = null;
  private sampleRate = 16000;
  private flushing = false;
  private closed = false;
  private speaking = false;

  // ── Connect / Disconnect ──────────────────────────────────────────

  async connect(config: STTConfig): Promise<void> {
    this.config = config;
    this.sampleRate = config.sampleRate ?? 16000;
    this.closed = false;
    this.chunks = [];
    this.totalBytes = 0;
    this.speaking = false;
    this.silenceStart = null;
    log.info("ready (batch mode)");
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    // Flush remaining audio before closing
    if (this.totalBytes > 0) {
      await this.flush();
    }
    this.chunks = [];
    this.totalBytes = 0;
    this.emit("close");
  }

  // ── Audio input ───────────────────────────────────────────────────

  sendAudio(pcm16: Buffer): void {
    if (this.closed) return;

    this.chunks.push(pcm16);
    this.totalBytes += pcm16.length;

    // Simple energy-based silence detection
    const rms = this.computeRMS(pcm16);
    if (rms < ENERGY_FLOOR) {
      if (!this.silenceStart) {
        this.silenceStart = Date.now();
      } else if (Date.now() - this.silenceStart >= SILENCE_THRESHOLD_MS && this.totalBytes > 0) {
        // Silence exceeded threshold — auto-flush
        this.silenceStart = null;
        this.flush().catch((err: unknown) => {
          log.error({ err }, "auto-flush failed");
        });
      }
    } else {
      // Voice activity
      if (this.silenceStart) {
        this.emit("speech_started");
      }
      this.silenceStart = null;
    }
  }

  // ── Flush (trigger transcription) ────────────────────────────────

  async flush(): Promise<void> {
    if (this.flushing || this.totalBytes === 0) return;
    this.flushing = true;

    const audioBuffer = Buffer.concat(this.chunks);
    this.chunks = [];
    this.totalBytes = 0;

    try {
      const wav = this.pcmToWav(audioBuffer, this.sampleRate);
      const transcript = await this.transcribe(wav);

      if (transcript) {
        const event: TranscriptEvent = {
          text: transcript,
          isFinal: true,
          confidence: 1.0, // Groq doesn't return confidence
          speechFinal: true,
        };
        this.emit("transcript", event);
        this.emit("speech_ended");
        this.emit("utterance_end");
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error({ err: error }, "transcription failed");
      this.emit("error", error);
    } finally {
      this.flushing = false;
    }
  }

  // ── HTTP transcription ────────────────────────────────────────────

  private async transcribe(wav: Buffer): Promise<string> {
    const apiKey = this.config!.apiKey;

    // Use native FormData (Node 22+) — no manual multipart needed
    const formData = new FormData();
    formData.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
    formData.append("model", "whisper-large-v3-turbo");
    const lang = this.config?.language === "multi" ? "en" : this.config?.language;
    if (lang) formData.append("language", lang);

    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Groq STT ${res.status}: ${text}`);
    }

    const json = (await res.json()) as { text?: string };
    return (json.text ?? "").trim();
  }

  // ── PCM16 → WAV conversion ───────────────────────────────────────

  private pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcm.length;
    const headerSize = 44;

    const header = Buffer.alloc(headerSize);
    // RIFF header
    header.write("RIFF", 0);
    header.writeUInt32LE(dataSize + headerSize - 8, 4);
    header.write("WAVE", 8);
    // fmt sub-chunk
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16); // sub-chunk size
    header.writeUInt16LE(1, 20); // PCM format
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    // data sub-chunk
    header.write("data", 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcm]);
  }

  // ── Energy detection ──────────────────────────────────────────────

  private computeRMS(pcm16: Buffer): number {
    if (pcm16.length < 2) return 0;
    let sumSquares = 0;
    const sampleCount = Math.floor(pcm16.length / 2);
    for (let i = 0; i < sampleCount; i++) {
      const sample = pcm16.readInt16LE(i * 2);
      sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / sampleCount);
  }
}
