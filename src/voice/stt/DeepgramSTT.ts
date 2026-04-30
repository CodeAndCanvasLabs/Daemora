/**
 * DeepgramSTT — streaming speech-to-text via Deepgram WebSocket API.
 *
 * Connects to wss://api.deepgram.com/v1/listen, sends raw PCM16
 * frames, and emits transcript / speech lifecycle events.
 */

import { WebSocket } from "ws";
import { createLogger } from "../../util/logger.js";
import {
  STTAdapter,
  type STTConfig,
  type TranscriptEvent,
} from "./STTAdapter.js";

const log = createLogger("voice:stt:deepgram");

const DEEPGRAM_WS = "wss://api.deepgram.com/v1/listen";
const KEEPALIVE_MS = 5_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

export class DeepgramSTT extends STTAdapter {
  readonly id = "deepgram";
  readonly streaming = true;

  private ws: WebSocket | null = null;
  private config: STTConfig | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private retryCount = 0;
  private closing = false;
  private connected = false;

  // ── Connect ───────────────────────────────────────────────────────

  async connect(config: STTConfig): Promise<void> {
    this.config = config;
    this.closing = false;
    this.retryCount = 0;
    await this.open();
  }

  private open(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const c = this.config!;
      const params = new URLSearchParams({
        encoding: c.encoding ?? "linear16",
        sample_rate: String(c.sampleRate ?? 16000),
        channels: "1",
        interim_results: String(c.interimResults ?? true),
        endpointing: String(c.endpointingMs ?? 300),
        utterance_end_ms: "1000",
        smart_format: "true",
      });
      if (c.language) params.set("language", c.language);

      const url = `${DEEPGRAM_WS}?${params.toString()}`;

      const ws = new WebSocket(url, {
        headers: { Authorization: `Token ${c.apiKey}` },
      });

      let settled = false;

      ws.on("open", () => {
        log.info("connected");
        this.connected = true;
        this.retryCount = 0;
        this.startKeepAlive();
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
        this.stopKeepAlive();
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
      log.warn("non-json message from deepgram");
      return;
    }

    const type = msg["type"] as string | undefined;

    if (type === "SpeechStarted") {
      this.emit("speech_started");
      return;
    }

    if (type === "UtteranceEnd") {
      this.emit("utterance_end");
      this.emit("speech_ended");
      return;
    }

    // Transcript result
    if (type === "Results") {
      const channel = (msg["channel"] as Record<string, unknown> | undefined);
      const alternatives = (channel?.["alternatives"] as Array<Record<string, unknown>> | undefined);
      if (!alternatives?.length) return;

      const best = alternatives[0]!;
      const transcript = (best["transcript"] as string) ?? "";
      if (!transcript) return;

      const event: TranscriptEvent = {
        text: transcript,
        isFinal: (msg["is_final"] as boolean) ?? false,
        confidence: (best["confidence"] as number) ?? 0,
        speechFinal: (msg["speech_final"] as boolean) ?? false,
      };

      this.emit("transcript", event);
    }
  }

  // ── Send audio ────────────────────────────────────────────────────

  sendAudio(pcm16: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm16);
    }
  }

  // ── Keep-alive ────────────────────────────────────────────────────

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Deepgram expects a KeepAlive JSON message
        this.ws.send(JSON.stringify({ type: "KeepAlive" }));
      }
    }, KEEPALIVE_MS);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  // ── Reconnection ──────────────────────────────────────────────────

  private maybeReconnect(): void {
    if (this.retryCount >= MAX_RETRIES) {
      log.error("max reconnect attempts reached");
      this.emit("error", new Error("Deepgram STT: max reconnect attempts exceeded"));
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
    this.stopKeepAlive();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Deepgram close-stream protocol
      this.ws.send(JSON.stringify({ type: "CloseStream" }));
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.ws?.terminate();
          resolve();
        }, 2000);
        this.ws!.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    } else {
      this.ws?.terminate();
    }

    this.ws = null;
    this.connected = false;
  }
}
