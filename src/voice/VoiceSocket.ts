/**
 * VoiceSocket — WebSocket endpoint for voice conversations.
 *
 * Handles:
 *   - ws://host/api/voice/ws — voice session WebSocket
 *   - Binary frames = PCM audio (16kHz, 16-bit, mono)
 *   - Text frames = JSON control messages
 *   - Creates one VoiceSession per connection
 *   - Routes audio between browser ↔ STT/TTS
 *
 * Protocol:
 *   Client → Server (binary): raw PCM audio from mic
 *   Client → Server (text):   { type: "start" | "stop" | "interrupt" | "config", ... }
 *   Server → Client (binary): audio chunks from TTS
 *   Server → Client (text):   { type: "state" | "transcript" | "tool" | "error" | "stop_playback", ... }
 */

import { type IncomingMessage } from "node:http";
import { type Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

import type { ConfigManager } from "../config/ConfigManager.js";
import type { AgentLoop } from "../core/AgentLoop.js";
import type { SessionStore } from "../memory/SessionStore.js";
import type { TaskStore } from "../tasks/TaskStore.js";
import { createLogger } from "../util/logger.js";
import { isHallucinatedTranscript } from "./transcriptFilter.js";
import { VoiceSession, type VoiceSessionConfig } from "./VoiceSession.js";

const log = createLogger("voice.socket");

export interface VoiceSocketDeps {
  readonly cfg: ConfigManager;
  readonly agent: AgentLoop;
  readonly sessions: SessionStore;
  readonly tasks: TaskStore;
}

export class VoiceSocketServer {
  private wss: WebSocketServer | null = null;
  private readonly activeSessions = new Map<string, { ws: WebSocket; session: VoiceSession }>();

  constructor(private readonly deps: VoiceSocketDeps) {}

  /**
   * Attach to an existing HTTP server. Handles upgrade requests
   * for `/api/voice/ws`.
   */
  attach(server: Server): void {
    this.wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req: IncomingMessage, socket, head) => {
      if (req.url?.startsWith("/api/voice/ws")) {
        this.wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          this.handleConnection(ws, req);
        });
      }
      // Other upgrade requests (e.g. SSE) are handled by Express
    });

    log.info("voice WebSocket server attached");
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const clientId = req.headers["x-client-id"] as string ?? `client-${Date.now()}`;
    log.info({ clientId }, "voice WebSocket connected");

    // Check for existing session from this client
    const existing = this.activeSessions.get(clientId);
    if (existing) {
      existing.session.disconnect();
      existing.ws.close();
      this.activeSessions.delete(clientId);
    }

    let session: VoiceSession | null = null;

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    (ws as any).on("message", async (data: any, isBinary: any) => {
      if (isBinary) {
        // Binary = raw PCM audio from mic
        if (session) {
          session.receiveAudio(Buffer.from(data as ArrayBuffer));
        }
        return;
      }

      // Text = JSON control message
      try {
        const msg = JSON.parse(String(data)) as {
          type: string;
          sttProvider?: string;
          ttsProvider?: string;
          ttsVoice?: string;
          language?: string;
        };

        switch (msg.type) {
          case "start": {
            if (session) {
              session.disconnect();
            }

            // Read provider keys from vault — auto-fallback if preferred provider's key missing
            const sttProviders = [
              msg.sttProvider ?? (this.deps.cfg.settings.getGeneric("DAEMORA_STT_PROVIDER") as string),
              "deepgram", "groq", "openai", "assemblyai",
            ].filter(Boolean) as string[];
            const ttsProviders = [
              msg.ttsProvider ?? (this.deps.cfg.settings.getGeneric("DAEMORA_TTS_PROVIDER") as string),
              "openai", "elevenlabs", "cartesia", "groq",
            ].filter(Boolean) as string[];

            const sttKeyMap: Record<string, string> = {
              deepgram: "DEEPGRAM_API_KEY", groq: "GROQ_API_KEY",
              openai: "OPENAI_API_KEY", assemblyai: "ASSEMBLYAI_API_KEY",
            };
            const ttsKeyMap: Record<string, string> = {
              elevenlabs: "ELEVENLABS_API_KEY", openai: "OPENAI_API_KEY",
              cartesia: "CARTESIA_API_KEY", groq: "GROQ_API_KEY",
            };

            // Find first provider with a key
            let sttProvider = ""; let sttApiKey = "";
            for (const p of sttProviders) {
              const key = this.deps.cfg.vault.get(sttKeyMap[p] ?? "")?.reveal();
              if (key) { sttProvider = p; sttApiKey = key; break; }
            }
            let ttsProvider = ""; let ttsApiKey = "";
            for (const p of ttsProviders) {
              const key = this.deps.cfg.vault.get(ttsKeyMap[p] ?? "")?.reveal();
              if (key) { ttsProvider = p; ttsApiKey = key; break; }
            }

            if (!sttApiKey) {
              this.sendJson(ws, { type: "error", message: "No STT provider key found. Set DEEPGRAM_API_KEY, GROQ_API_KEY, or OPENAI_API_KEY in Settings." });
              return;
            }
            if (!ttsApiKey) {
              this.sendJson(ws, { type: "error", message: "No TTS provider key found. Set OPENAI_API_KEY, ELEVENLABS_API_KEY, or CARTESIA_API_KEY in Settings." });
              return;
            }

            // Read ALL config from user's settings — no hardcoded defaults
            const userTtsModel = this.deps.cfg.settings.getGeneric("TTS_MODEL") as string | undefined;
            const userTtsVoice = this.deps.cfg.settings.getGeneric("TTS_VOICE") as string | undefined;

            // Base URLs per provider (only thing that's structural, not user config)
            const baseURLs: Record<string, string> = {
              groq: "https://api.groq.com/openai/v1",
              openai: "https://api.openai.com/v1",
            };

            const config: VoiceSessionConfig = {
              sttProvider,
              sttApiKey,
              ttsProvider,
              ttsApiKey,
              ttsVoice: msg.ttsVoice ?? userTtsVoice ?? "nova",
              ...(userTtsModel ? { ttsModel: userTtsModel } : {}),
              ...(baseURLs[ttsProvider] ? { ttsBaseURL: baseURLs[ttsProvider] } : {}),
              language: msg.language ?? "multi",
              processText: (text, sessionId) => this.processWithAgent(text, sessionId),
            };

            session = new VoiceSession(config);
            this.activeSessions.set(clientId, { ws, session });

            // Wire session events → WebSocket
            session.on("state", (ev) => this.sendJson(ws, { type: "state", ...ev }));
            session.on("audio_out", (chunk: Buffer) => {
              if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
            });
            session.on("transcript", (ev) => this.sendJson(ws, { type: "transcript", ...ev }));
            session.on("tool", (ev) => this.sendJson(ws, { type: "tool", ...ev }));
            session.on("stop_playback", () => this.sendJson(ws, { type: "stop_playback" }));
            session.on("filler", (kind) => this.sendJson(ws, { type: "filler", kind }));
            session.on("error", (err) => this.sendJson(ws, { type: "error", message: err.message }));
            session.on("metrics", (m) => {
              this.sendJson(ws, { type: "metrics", ...m });
              log.info({ sessionId: m.sessionId, turns: m.turns, avgLatency: m.latencies.length > 0 ? Math.round(m.latencies.reduce((a: number, b: number) => a + b, 0) / m.latencies.length) : 0 }, "voice session metrics");
            });

            await session.connect();
            break;
          }

          case "stop":
            session?.disconnect();
            session = null;
            this.activeSessions.delete(clientId);
            break;

          case "interrupt":
            if (session && (session.state === "speaking" || session.state === "thinking")) {
              session["transition"]("cancelling");
            }
            break;

          default:
            log.warn({ type: msg.type }, "unknown voice message type");
        }
      } catch (e) {
        log.error({ err: (e as Error).message }, "voice message parse error");
      }
    });

    ws.on("close", () => {
      log.info({ clientId }, "voice WebSocket disconnected");
      session?.disconnect();
      this.activeSessions.delete(clientId);
    });

    ws.on("error", (err) => {
      log.error({ clientId, err: err.message }, "voice WebSocket error");
      session?.disconnect();
      this.activeSessions.delete(clientId);
    });
  }

  /**
   * Process user text through the same /api/chat flow as text.
   * Uses the "main" session — voice and text share one conversation.
   * Persists to task log, saves to session history, tracks tool calls.
   */
  private async processWithAgent(text: string, _sessionId: string): Promise<AsyncIterable<string>> {
    const chatSessionId = "main"; // same session as text chat

    // Reject known Whisper / Groq hallucinations on silence before they
    // reach the agent. These strings show up constantly when the mic is
    // open but the user isn't speaking — letting them through creates
    // phantom "thank you" / "thanks for watching" messages in the
    // shared chat history.
    if (isHallucinatedTranscript(text)) {
      log.debug({ text }, "voice: rejecting hallucinated transcript");
      async function* empty(): AsyncIterable<string> {}
      return empty();
    }

    // Ensure session exists
    if (!this.deps.sessions.getSession(chatSessionId)) {
      this.deps.sessions.createSessionWithId(chatSessionId, { title: "Chat" });
    }

    // Save user message to session (same as text chat does)
    const userMsg = { role: "user" as const, content: text };
    this.deps.sessions.appendMessage(chatSessionId, userMsg);

    // Load history for context
    const history = this.deps.sessions.getHistory(chatSessionId, { limit: 40 });
    const priorHistory = history.slice(0, -1);

    // Create task for logging
    const taskId = `voice-${Date.now()}`;
    this.deps.tasks.create(taskId, chatSessionId, text);

    const startedAt = Date.now();
    let toolCallCount = 0;

    const turn = await this.deps.agent.run({
      taskId,
      userMessage: text,
      history: priorHistory,
      abortSignal: AbortSignal.timeout(60_000),
    });

    const deps = this.deps;
    async function* textAndTrack(): AsyncIterable<string> {
      let fullText = "";
      try {
        for await (const ev of turn.eventStream) {
          if (ev.type === "text-delta") {
            fullText += ev.delta;
            yield ev.delta;
          } else if (ev.type === "tool-call") {
            toolCallCount++;
          } else if (ev.type === "tool-result") {
            deps.tasks.recordToolCall(taskId, ev.name, undefined, ev.result);
          }
        }

        // Save assistant response to session
        const responseMessages = await turn.responseMessages();
        for (const msg of responseMessages) {
          deps.sessions.appendMessage(chatSessionId, msg);
        }

        // Complete task
        deps.tasks.complete(taskId, {
          result: fullText,
          toolCalls: toolCallCount,
          durationMs: Date.now() - startedAt,
        });
      } catch (e) {
        deps.tasks.fail(taskId, (e as Error).message, Date.now() - startedAt);
        throw e;
      }
    }

    return textAndTrack();
  }

  private sendJson(ws: WebSocket, data: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  /** Shutdown all sessions. */
  close(): void {
    for (const { session } of this.activeSessions.values()) {
      session.disconnect();
    }
    this.activeSessions.clear();
    this.wss?.close();
  }
}

