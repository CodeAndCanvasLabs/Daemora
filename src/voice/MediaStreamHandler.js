/**
 * MediaStreamHandler - Twilio WebSocket media stream (bidirectional audio).
 *
 * Twilio opens a WebSocket when a call connects (via <Connect><Stream> in TwiML).
 * This handler:
 *   - Receives mu-law 8kHz audio frames from Twilio → routes to STT
 *   - Sends mu-law 8kHz TTS audio back to Twilio → caller hears the bot
 *   - Handles barge-in: AbortController cancels queued TTS when caller speaks
 *
 * Based on OpenClaw's media-stream.ts pattern.
 */

import { WebSocketServer } from "ws";
import { chunkBuffer, sleep } from "../meeting/TelephonyAudio.js";

const CHUNK_SIZE = 160;    // 20ms @ 8kHz mu-law
const CHUNK_DELAY_MS = 20; // pace TTS playback to real-time

// Global registry: sessionToken → MediaStream instance
const _streams = new Map();

export class MediaStream {
  constructor(ws, sessionToken) {
    this.ws = ws;
    this.sessionToken = sessionToken;
    this.streamSid = null;
    this.callSid = null;

    // TTS queue - serializes playback, prevents overlap
    this._ttsQueue = [];
    this._ttsProcessing = false;

    // Barge-in: AbortController for current playback
    this._currentPlayController = null;

    // Callbacks set by the meeting/call manager
    this.onAudio = null;    // (mulawChunk: Buffer) => void
    this.onStart = null;    // (streamSid, callSid) => void
    this.onStop = null;     // () => void
    this.onMark = null;     // (name: string) => void

    ws.on("message", (data) => this._onMessage(data));
    ws.on("close", () => {
      _streams.delete(sessionToken);
      if (this.onStop) this.onStop();
    });
    ws.on("error", (e) => console.log(`[MediaStream:${sessionToken}] error: ${e.message}`));

    _streams.set(sessionToken, this);
    console.log(`[MediaStream] New stream: ${sessionToken}`);
  }

  _onMessage(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      switch (msg.event) {
        case "start":
          this.streamSid = msg.start?.streamSid;
          this.callSid = msg.start?.callSid || msg.start?.customParameters?.callSid;
          console.log(`[MediaStream:${this.sessionToken}] Started - streamSid: ${this.streamSid}`);
          if (this.onStart) this.onStart(this.streamSid, this.callSid);
          break;

        case "media":
          if (msg.media?.payload && this.onAudio) {
            this.onAudio(Buffer.from(msg.media.payload, "base64"));
          }
          break;

        case "mark":
          if (this.onMark) this.onMark(msg.mark?.name);
          break;

        case "stop":
          console.log(`[MediaStream:${this.sessionToken}] Stopped`);
          if (this.onStop) this.onStop();
          break;
      }
    } catch {}
  }

  /**
   * Queue TTS audio for playback. Serialized - won't overlap.
   * Returns a promise that resolves when audio finishes playing.
   * @param {Buffer} mulawBuf - mu-law 8kHz audio
   * @returns {Promise<void>}
   */
  queueAudio(mulawBuf) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      this._ttsQueue.push({ mulawBuf, controller, resolve, reject });
      this._processQueue();
    });
  }

  /**
   * Barge-in: abort current playback and clear queue.
   */
  clearQueue() {
    // Abort current playback
    if (this._currentPlayController) {
      this._currentPlayController.abort();
      this._currentPlayController = null;
    }
    // Clear queued entries
    for (const entry of this._ttsQueue) {
      entry.resolve(); // resolve cleanly so callers don't hang
    }
    this._ttsQueue = [];
    this._ttsProcessing = false;

    // Tell Twilio to clear its audio buffer too
    if (this.streamSid && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ event: "clear", streamSid: this.streamSid }));
    }
  }

  async _processQueue() {
    if (this._ttsProcessing) return;
    this._ttsProcessing = true;

    while (this._ttsQueue.length > 0) {
      const entry = this._ttsQueue.shift();
      this._currentPlayController = entry.controller;
      try {
        await this._playAudio(entry.mulawBuf, entry.controller.signal);
        entry.resolve();
      } catch (e) {
        entry.resolve(); // resolve even on abort
      }
      this._currentPlayController = null;
    }

    this._ttsProcessing = false;
  }

  async _playAudio(mulawBuf, signal) {
    if (!this.streamSid || this.ws.readyState !== 1) return;
    const chunks = chunkBuffer(mulawBuf, CHUNK_SIZE);

    for (const chunk of chunks) {
      if (signal?.aborted) break;
      this.ws.send(JSON.stringify({
        event: "media",
        streamSid: this.streamSid,
        media: { payload: chunk.toString("base64") },
      }));
      await sleep(CHUNK_DELAY_MS);
    }

    // Send mark so we can detect when Twilio finishes playing
    if (!signal?.aborted && this.streamSid) {
      this.ws.send(JSON.stringify({
        event: "mark",
        streamSid: this.streamSid,
        mark: { name: `tts-${Date.now()}` },
      }));
    }
  }

  close() {
    try { this.ws.close(); } catch {}
    _streams.delete(this.sessionToken);
  }
}

/**
 * Attach MediaStreamHandler to an HTTP server.
 * Upgrades WebSocket connections on /voice/stream.
 *
 * @param {import('http').Server} httpServer
 */
export function attachMediaStreamServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/voice/stream")) {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token");
    if (!token) { socket.destroy(); return; }

    wss.handleUpgrade(req, socket, head, (ws) => {
      new MediaStream(ws, token);
    });
  });

  console.log("[MediaStream] WebSocket handler attached at /voice/stream");
}

/**
 * Get a MediaStream by session token.
 */
export function getStream(token) {
  return _streams.get(token) || null;
}
