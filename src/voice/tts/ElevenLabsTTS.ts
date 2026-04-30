/**
 * ElevenLabsTTS — streaming text-to-speech via ElevenLabs WebSocket API.
 *
 * Sends text tokens incrementally over a WebSocket and receives
 * base64-encoded MP3 audio chunks in real time.
 */

import { WebSocket } from "ws";
import { createLogger } from "../../util/logger.js";
import {
  TTSAdapter,
  type AudioFormat,
  type TTSConfig,
} from "./TTSAdapter.js";

const log = createLogger("voice:tts:elevenlabs");

const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"; // Rachel
const DEFAULT_MODEL = "eleven_turbo_v2_5";
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

const AUDIO_FORMAT: AudioFormat = {
  encoding: "mp3",
  sampleRate: 44100,
  channels: 1,
};

export class ElevenLabsTTS extends TTSAdapter {
  readonly id = "elevenlabs";
  readonly streaming = true;

  private ws: WebSocket | null = null;
  private config: TTSConfig | null = null;
  private voiceId = DEFAULT_VOICE;
  private modelId = DEFAULT_MODEL;
  private retryCount = 0;
  private closing = false;
  private connected = false;
  private initialized = false;

  // ── Connect ───────────────────────────────────────────────────────

  async connect(config: TTSConfig): Promise<void> {
    this.config = config;
    this.voiceId = config.voice ?? DEFAULT_VOICE;
    this.modelId = config.model ?? DEFAULT_MODEL;
    this.closing = false;
    this.retryCount = 0;
    await this.open();
  }

  private open(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const c = this.config!;
      const outputFormat = c.outputFormat === "pcm16" ? "pcm_16000" : "mp3_44100_128";
      const url =
        `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream-input` +
        `?model_id=${this.modelId}&output_format=${outputFormat}`;

      const ws = new WebSocket(url, {
        headers: { "xi-api-key": c.apiKey },
      });

      let settled = false;

      ws.on("open", () => {
        log.info("connected");
        this.connected = true;
        this.retryCount = 0;
        this.sendInitMessage();
        if (!settled) { settled = true; resolve(); }
      });

      ws.on("message", (raw: Buffer | string) => {
        this.handleMessage(raw);
      });

      ws.on("error", (err: Error) => {
        log.error({ err }, "ws error");
        this.emit("error", err);
        if (!settled) { settled = true; reject(err); }
      });

      ws.on("close", (code: number, reason: Buffer) => {
        this.connected = false;
        this.initialized = false;
        const reasonStr = reason.toString();
        log.info({ code, reason: reasonStr }, "ws closed");
        this.emit("close", code, reasonStr);

        if (!this.closing) {
          this.maybeReconnect();
        }
      });

      this.ws = ws;
    });
  }

  // ── Init message (required by ElevenLabs) ─────────────────────────

  private sendInitMessage(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(
      JSON.stringify({
        text: " ",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
        generation_config: {
          chunk_length_schedule: [120, 160, 250, 290],
        },
      }),
    );
    this.initialized = true;
  }

  // ── Incoming messages ─────────────────────────────────────────────

  private handleMessage(raw: Buffer | string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf-8")) as Record<string, unknown>;
    } catch {
      log.warn("non-json message from elevenlabs");
      return;
    }

    // Error from the API
    if (msg["error"]) {
      const errMsg = typeof msg["error"] === "string" ? msg["error"] : JSON.stringify(msg["error"]);
      log.error({ error: errMsg }, "api error");
      this.emit("error", new Error(`ElevenLabs: ${errMsg}`));
      return;
    }

    // Audio chunk
    const audio = msg["audio"] as string | undefined;
    if (audio) {
      const chunk = Buffer.from(audio, "base64");
      const format: AudioFormat = this.config?.outputFormat === "pcm16"
        ? { encoding: "pcm16", sampleRate: this.config.sampleRate ?? 16000, channels: 1 }
        : AUDIO_FORMAT;
      this.emit("audio", chunk, format);
    }

    // Final marker
    if (msg["isFinal"] === true) {
      this.emit("flushed");
    }
  }

  // ── Send text ─────────────────────────────────────────────────────

  sendText(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn("sendText called while not connected");
      return;
    }

    if (!this.initialized) {
      this.sendInitMessage();
    }

    this.ws.send(
      JSON.stringify({
        text,
        try_trigger_generation: true,
      }),
    );
  }

  // ── Flush (signal end of text) ────────────────────────────────────

  flush(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ text: "" }));
    }
  }

  // ── Cancel (interrupt) ────────────────────────────────────────────

  cancel(): void {
    if (!this.ws) return;

    // Close current connection and reconnect for next utterance
    this.ws.terminate();
    this.ws = null;
    this.connected = false;
    this.initialized = false;

    if (!this.closing && this.config) {
      this.open().catch((err: unknown) => {
        log.error({ err }, "reconnect after cancel failed");
      });
    }
  }

  // ── Reconnection ──────────────────────────────────────────────────

  private maybeReconnect(): void {
    if (this.retryCount >= MAX_RETRIES) {
      log.error("max reconnect attempts reached");
      this.emit("error", new Error("ElevenLabs TTS: max reconnect attempts exceeded"));
      return;
    }

    this.retryCount++;
    const delay = BASE_BACKOFF_MS * Math.pow(2, this.retryCount - 1);
    log.info({ attempt: this.retryCount, delay }, "reconnecting");

    setTimeout(() => {
      if (this.closing) return;
      this.open().catch((err: unknown) => {
        log.error({ err }, "reconnect failed");
      });
    }, delay);
  }

  // ── Disconnect ────────────────────────────────────────────────────

  async disconnect(): Promise<void> {
    this.closing = true;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Send empty text to flush, then close
      this.ws.send(JSON.stringify({ text: "" }));
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.ws?.terminate();
          resolve();
        }, 2000);
        this.ws!.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
        this.ws!.close();
      });
    } else {
      this.ws?.terminate();
    }

    this.ws = null;
    this.connected = false;
    this.initialized = false;
  }
}
