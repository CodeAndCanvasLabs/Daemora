/**
 * CartesiaTTS — WebSocket streaming text-to-speech via Cartesia API.
 *
 * Lowest-latency option: sends text, receives raw PCM16 chunks
 * with no codec decode step. Supports mid-stream cancellation
 * via context_id.
 */

import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { createLogger } from "../../util/logger.js";
import {
  TTSAdapter,
  type AudioFormat,
  type TTSConfig,
} from "./TTSAdapter.js";

const log = createLogger("voice:tts:cartesia");

const DEFAULT_VOICE = "a0e99841-438c-4a64-b679-ae501e7d6091"; // Barbershop Man
const DEFAULT_MODEL = "sonic-english";
const CARTESIA_VERSION = "2024-06-10";
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

export class CartesiaTTS extends TTSAdapter {
  readonly id = "cartesia";
  readonly streaming = true;

  private ws: WebSocket | null = null;
  private config: TTSConfig | null = null;
  private voiceId = DEFAULT_VOICE;
  private modelId = DEFAULT_MODEL;
  private contextId = randomUUID();
  private retryCount = 0;
  private closing = false;
  private connected = false;
  private textBuffer = "";
  private audioFormat: AudioFormat = {
    encoding: "pcm16",
    sampleRate: 16000,
    channels: 1,
  };

  // ── Connect ───────────────────────────────────────────────────────

  async connect(config: TTSConfig): Promise<void> {
    this.config = config;
    this.voiceId = config.voice ?? DEFAULT_VOICE;
    this.modelId = config.model ?? DEFAULT_MODEL;
    this.audioFormat = {
      encoding: "pcm16",
      sampleRate: config.sampleRate ?? 16000,
      channels: 1,
    };
    this.closing = false;
    this.retryCount = 0;
    await this.open();
  }

  private open(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const c = this.config!;
      const url =
        `wss://api.cartesia.ai/tts/websocket` +
        `?api_key=${c.apiKey}&cartesia_version=${CARTESIA_VERSION}`;

      const ws = new WebSocket(url);

      let settled = false;

      ws.on("open", () => {
        log.info("connected");
        this.connected = true;
        this.retryCount = 0;
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

  // ── Incoming messages ─────────────────────────────────────────────

  private handleMessage(raw: Buffer | string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf-8")) as Record<string, unknown>;
    } catch {
      log.warn("non-json message from cartesia");
      return;
    }

    // Error from the API
    if (msg["error"]) {
      const errMsg = typeof msg["error"] === "string" ? msg["error"] : JSON.stringify(msg["error"]);
      log.error({ error: errMsg }, "api error");
      this.emit("error", new Error(`Cartesia: ${errMsg}`));
      return;
    }

    // Audio chunk
    const data = msg["data"] as string | undefined;
    if (data) {
      const chunk = Buffer.from(data, "base64");
      this.emit("audio", chunk, this.audioFormat);
    }

    // Done marker
    if (msg["done"] === true) {
      this.emit("flushed");
    }
  }

  // ── Send text ─────────────────────────────────────────────────────

  sendText(text: string): void {
    this.textBuffer += text;
  }

  // ── Flush (send accumulated text) ─────────────────────────────────

  flush(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn("flush called while not connected");
      return;
    }

    if (!this.textBuffer.trim()) return;

    const text = this.textBuffer;
    this.textBuffer = "";
    this.contextId = randomUUID();

    const sampleRate = this.config?.sampleRate ?? 16000;

    this.ws.send(
      JSON.stringify({
        model_id: this.modelId,
        transcript: text,
        voice: {
          mode: "id",
          id: this.voiceId,
        },
        output_format: {
          container: "raw",
          encoding: "pcm_s16le",
          sample_rate: sampleRate,
        },
        context_id: this.contextId,
      }),
    );
  }

  // ── Cancel (interrupt) ────────────────────────────────────────────

  cancel(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          cancel: true,
          context_id: this.contextId,
        }),
      );
    }
    this.textBuffer = "";
    // Rotate context for next utterance
    this.contextId = randomUUID();
  }

  // ── Reconnection ──────────────────────────────────────────────────

  private maybeReconnect(): void {
    if (this.retryCount >= MAX_RETRIES) {
      log.error("max reconnect attempts reached");
      this.emit("error", new Error("Cartesia TTS: max reconnect attempts exceeded"));
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
    this.textBuffer = "";
  }
}
