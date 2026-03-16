/**
 * RealtimeSTT — OpenAI Realtime API transcription over WebSocket.
 *
 * Accepts G.711 mu-law 8kHz audio (native telephony format — no resampling needed).
 * Uses server-side VAD for speech detection.
 * Emits: onTranscript(text), onPartial(text), onSpeechStart(), onError(err)
 *
 * Based on OpenClaw's stt-openai-realtime.ts pattern.
 */

import { WebSocket } from "ws";

const MAX_RECONNECT = 5;
const RECONNECT_BASE_MS = 1000;
const CONNECT_TIMEOUT_MS = 10000;

export class RealtimeSTT {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {function} opts.onTranscript - (text: string) => void
   * @param {function} [opts.onPartial] - (text: string) => void
   * @param {function} [opts.onSpeechStart] - () => void
   * @param {function} [opts.onError] - (err: Error) => void
   * @param {number} [opts.silenceDurationMs] - VAD silence threshold (default 800ms)
   * @param {number} [opts.vadThreshold] - VAD sensitivity 0-1 (default 0.5)
   */
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.onTranscript = opts.onTranscript;
    this.onPartial = opts.onPartial || (() => {});
    this.onSpeechStart = opts.onSpeechStart || (() => {});
    this.onError = opts.onError || ((e) => console.error("[RealtimeSTT]", e.message));
    this.silenceDurationMs = opts.silenceDurationMs ?? 800;
    this.vadThreshold = opts.vadThreshold ?? 0.5;

    this._ws = null;
    this._closed = false;
    this._reconnectAttempts = 0;
    this._pendingTranscript = "";
  }

  async connect() {
    this._closed = false;
    await this._doConnect();
  }

  _doConnect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      const timeout = setTimeout(() => {
        ws.terminate();
        reject(new Error("RealtimeSTT: connection timeout"));
      }, CONNECT_TIMEOUT_MS);

      ws.on("open", () => {
        clearTimeout(timeout);
        this._ws = ws;
        this._reconnectAttempts = 0;
        console.log("[RealtimeSTT] Connected — server-side VAD, native mu-law");

        // Configure transcription session
        ws.send(JSON.stringify({
          type: "transcription_session.update",
          session: {
            input_audio_format: "g711_ulaw",
            input_audio_transcription: { model: "gpt-4o-transcribe" },
            turn_detection: {
              type: "server_vad",
              threshold: this.vadThreshold,
              prefix_padding_ms: 300,
              silence_duration_ms: this.silenceDurationMs,
            },
          },
        }));

        resolve();
      });

      ws.on("message", (data) => this._onMessage(data));

      ws.on("close", () => {
        this._ws = null;
        if (!this._closed) {
          console.log("[RealtimeSTT] Disconnected — reconnecting...");
          this._reconnect();
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        if (!this._ws) reject(err); // initial connect failed
        else this.onError(err);
      });
    });
  }

  async _reconnect() {
    if (this._closed || this._reconnectAttempts >= MAX_RECONNECT) {
      this.onError(new Error(`RealtimeSTT: failed after ${MAX_RECONNECT} attempts`));
      return;
    }
    const delay = RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempts++);
    console.log(`[RealtimeSTT] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})`);
    await new Promise(r => setTimeout(r, delay));
    try { await this._doConnect(); }
    catch (e) { this._reconnect(); }
  }

  _onMessage(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {
        case "input_audio_buffer.speech_started":
          this.onSpeechStart();
          break;

        case "conversation.item.input_audio_transcription.delta":
          if (msg.delta) {
            this._pendingTranscript += msg.delta;
            this.onPartial(this._pendingTranscript);
          }
          break;

        case "conversation.item.input_audio_transcription.completed":
          if (msg.transcript?.trim()) {
            this.onTranscript(msg.transcript.trim());
          }
          this._pendingTranscript = "";
          break;

        case "error":
          this.onError(new Error(`RealtimeSTT API error: ${JSON.stringify(msg.error)}`));
          break;
      }
    } catch {}
  }

  /**
   * Send mu-law audio chunk to STT.
   * @param {Buffer} mulawChunk — 8kHz mono mu-law bytes
   */
  sendAudio(mulawChunk) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({
      type: "input_audio_buffer.append",
      audio: mulawChunk.toString("base64"),
    }));
  }

  close() {
    this._closed = true;
    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
  }
}
