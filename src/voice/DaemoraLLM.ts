/**
 * DaemoraLLM — LiveKit `llm.LLM` adapter that streams agent responses
 * from the main Daemora HTTP process over SSE.
 *
 * The LiveKit voice pipeline runs in a child worker process (rtc-node
 * crashes under tsx, so it has to be compiled + spawned separately).
 * That means the LLM bridge cannot hold a direct AgentLoop reference —
 * it has to talk to the running main process over HTTP.
 *
 * Protocol:
 *   1. POST /api/chat { input, sessionId: "main" } → { taskId }
 *   2. Subscribe to GET /api/tasks/:taskId/stream (SSE) and forward
 *      every `text:delta` event as a ChatChunk delta.
 *   3. Close the LLMStream queue on `task:state = completed|failed`.
 *
 * Because the web chat and voice share the same session id ("main"),
 * the conversation history is unified — a voice turn appears in the
 * web chat UI and vice versa.
 */

import { randomUUID } from "node:crypto";

import type { APIConnectOptions } from "@livekit/agents";
import { llm } from "@livekit/agents";

// Session shared with web chat + every channel so history is unified.
const VOICE_SESSION_ID = "main";

export interface DaemoraLLMOpts {
  /** Base URL of the main Daemora HTTP server. */
  readonly daemoraUrl: string;
  /** Optional model id (purely for `model` getter — routing happens on the server). */
  readonly model?: string;
}

export class DaemoraLLM extends llm.LLM {
  readonly daemoraUrl: string;
  readonly modelId: string;

  constructor(opts: DaemoraLLMOpts) {
    super();
    this.daemoraUrl = opts.daemoraUrl.replace(/\/$/, "");
    this.modelId = opts.model ?? "daemora";
  }

  override label(): string {
    return "daemora.LLM";
  }

  override get model(): string {
    return this.modelId;
  }

  override get provider(): string {
    return "daemora";
  }

  override chat({
    chatCtx,
    toolCtx,
    connOptions,
  }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): llm.LLMStream {
    return new DaemoraLLMStream(this, {
      chatCtx,
      ...(toolCtx ? { toolCtx } : {}),
      ...(connOptions ? { connOptions } : {}),
    });
  }
}

class DaemoraLLMStream extends llm.LLMStream {
  private readonly daemora: DaemoraLLM;

  constructor(
    daemora: DaemoraLLM,
    opts: {
      chatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContext;
      connOptions?: APIConnectOptions;
    },
  ) {
    const connOptions = opts.connOptions ?? ({ maxRetry: 0, timeoutMs: 120_000 } as APIConnectOptions);
    if (opts.toolCtx) {
      super(daemora, { chatCtx: opts.chatCtx, toolCtx: opts.toolCtx, connOptions });
    } else {
      super(daemora, { chatCtx: opts.chatCtx, connOptions });
    }
    this.daemora = daemora;
  }

  protected override async run(): Promise<void> {
    const userText = extractLatestUserText(this.chatCtx);
    const chunkId = randomUUID();

    if (!userText) {
      this.queue.close();
      return;
    }

    try {
      // Kick off the task.
      const kickoff = await fetch(`${this.daemora.daemoraUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: userText,
          sessionId: VOICE_SESSION_ID,
          // Flag: ask the server to add a "voice mode" prelude to the
          // system prompt so the reply is spoken-style (no markdown,
          // 1–3 short sentences). TTS reads bullet points and pipe
          // characters out loud otherwise.
          voiceMode: true,
        }),
        signal: this.abortController.signal,
      });
      if (!kickoff.ok) {
        throw new Error(`/api/chat ${kickoff.status}`);
      }
      const { taskId } = (await kickoff.json()) as { taskId: string };

      // Stream events for that task.
      await this.consumeSSE(`${this.daemora.daemoraUrl}/api/tasks/${taskId}/stream`, chunkId);
    } catch (err) {
      if (!this.abortController.signal.aborted) {
        // Surface the error up to the pipeline so it can recover.
        throw err;
      }
    } finally {
      this.queue.close();
    }
  }

  /**
   * Minimal SSE parser — reads `event:` / `data:` lines and routes
   * text deltas to the LLMStream queue. Terminates on `task:state`
   * with a completed / failed status, or when the stream ends.
   */
  private async consumeSSE(url: string, chunkId: string): Promise<void> {
    const resp = await fetch(url, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal: this.abortController.signal,
    });
    if (!resp.ok || !resp.body) throw new Error(`SSE ${resp.status}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let currentEvent = "";

    while (true) {
      if (this.abortController.signal.aborted) {
        try { await reader.cancel(); } catch {}
        return;
      }
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);

        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const dataRaw = line.slice(5).trim();
          if (!dataRaw) continue;
          let payload: unknown;
          try { payload = JSON.parse(dataRaw); } catch { continue; }

          if (currentEvent === "text:delta") {
            const delta = (payload as { delta?: string }).delta;
            if (delta) {
              this.queue.put({
                id: chunkId,
                delta: { role: "assistant", content: delta },
              });
            }
          } else if (currentEvent === "task:state") {
            const status = (payload as { status?: string }).status;
            if (status === "completed" || status === "failed") return;
          }
        }
        // blank line → dispatch boundary; nothing to do here.
      }
    }
  }
}

function extractLatestUserText(ctx: llm.ChatContext): string {
  const items = ctx.items;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) continue;
    if (item.type !== "message") continue;
    const msg = item as llm.ChatMessage;
    if (msg.role !== "user") continue;
    const text = msg.textContent;
    if (text && text.trim()) return text.trim();
  }
  return "";
}
