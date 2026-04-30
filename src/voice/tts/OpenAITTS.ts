/**
 * OpenAITTS — HTTP streaming text-to-speech via OpenAI's API.
 *
 * Not a WebSocket — accumulates text via sendText(), then on flush()
 * POSTs to /v1/audio/speech and streams the response body as audio chunks.
 * Good as a reliable fallback when WebSocket TTS is unavailable.
 */

import { createLogger } from "../../util/logger.js";
import {
  TTSAdapter,
  type AudioFormat,
  type TTSConfig,
} from "./TTSAdapter.js";

const log = createLogger("voice:tts:openai");

const DEFAULT_URL = "https://api.openai.com/v1/audio/speech";
const DEFAULT_VOICE = "nova";
const DEFAULT_MODEL = "tts-1";

export class OpenAITTS extends TTSAdapter {
  readonly id = "openai";
  readonly streaming = false; // HTTP streaming, not WS streaming

  private config: TTSConfig | null = null;
  private textBuffer = "";
  private abortController: AbortController | null = null;
  private closed = false;

  // ── Connect / Disconnect ──────────────────────────────────────────

  async connect(config: TTSConfig): Promise<void> {
    this.config = config;
    this.textBuffer = "";
    this.closed = false;
    log.info("ready (HTTP streaming mode)");
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.cancel();
    this.textBuffer = "";
    this.emit("close");
  }

  // ── Send text (buffer) ────────────────────────────────────────────

  sendText(text: string): void {
    if (this.closed) return;
    this.textBuffer += text;
  }

  // ── Flush (trigger HTTP request) ──────────────────────────────────

  flush(): void {
    if (this.closed || !this.textBuffer.trim()) return;

    const text = this.textBuffer;
    this.textBuffer = "";

    // Fire-and-forget — errors emitted as events
    this.synthesize(text).catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error({ err: error }, "synthesis failed");
      this.emit("error", error);
    });
  }

  // ── Cancel ────────────────────────────────────────────────────────

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.textBuffer = "";
  }

  // ── HTTP streaming synthesis ──────────────────────────────────────

  private async synthesize(text: string): Promise<void> {
    const c = this.config!;
    this.abortController = new AbortController();

    const isGroq = c.baseURL?.includes("groq") ?? false;
    const responseFormat = c.outputFormat === "pcm16" ? "pcm" : isGroq ? "wav" : (c.outputFormat ?? "mp3");
    const voice = c.voice ?? DEFAULT_VOICE;
    const model = c.model ?? DEFAULT_MODEL;

    const format: AudioFormat = responseFormat === "pcm"
      ? { encoding: "pcm16", sampleRate: c.sampleRate ?? 24000, channels: 1 }
      : responseFormat === "opus"
        ? { encoding: "opus", sampleRate: c.sampleRate ?? 48000, channels: 1 }
        : { encoding: "mp3", sampleRate: c.sampleRate ?? 24000, channels: 1 };
    // WAV handled same as MP3 for audio format metadata

    const url = this.config?.baseURL ? `${this.config.baseURL.replace(/\/+$/, "")}/audio/speech` : DEFAULT_URL;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        voice,
        input: text,
        response_format: responseFormat,
      }),
      signal: this.abortController.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI TTS ${res.status}: ${body}`);
    }

    if (!res.body) {
      throw new Error("OpenAI TTS: empty response body");
    }

    // Collect the complete audio response, then emit as one buffer.
    // Browser's decodeAudioData needs a complete file, not partial chunks.
    const chunks: Buffer[] = [];
    const reader = res.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.abortController?.signal.aborted) break;
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
      this.abortController = null;
    }

    // Emit the complete audio as one buffer
    if (chunks.length > 0) {
      const complete = Buffer.concat(chunks);
      log.info({ bytes: complete.length, format: format.encoding }, "TTS audio complete");
      this.emit("audio", complete, format);
    }

    this.emit("flushed");
  }
}
