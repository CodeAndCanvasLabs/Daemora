/**
 * TaskRunner — the one place where an agent turn is driven end-to-end.
 *
 * Both `/api/chat` (HTTP SSE) and ChannelManager (Discord/Telegram/etc.)
 * go through this runner so task persistence, session history, event
 * emission, and error handling are identical across entry points.
 *
 * A run:
 *   1. Resolves the session (creating it if needed for this sessionId).
 *   2. Persists user message + task row (with channel metadata).
 *   3. Drives AgentLoop, consuming its event stream.
 *   4. Emits lifecycle events to the EventBus (streaming deltas, tool
 *      calls, final state) — any subscriber keyed by taskId can react.
 *   5. Optionally forwards the same events to a local callback (SSE).
 *   6. Persists response messages to session history and writes the
 *      terminal state to TaskStore.
 *
 * Returns a sync handle with `taskId`, `sessionId`, and a `done`
 * promise that resolves with the terminal state.
 */

import { randomUUID } from "node:crypto";

import type { ModelMessage } from "ai";

import type { ChannelMeta } from "../channels/BaseChannel.js";
import type { ConfigManager } from "../config/ConfigManager.js";
import type { EventBus } from "../events/eventBus.js";
import type { HookRunner } from "../hooks/HookRunner.js";
import type { BackgroundReviewer } from "../learning/BackgroundReviewer.js";
import type { AttachmentMeta, SessionStore } from "../memory/SessionStore.js";
import type { TaskStore } from "../tasks/TaskStore.js";
import type { CostTracker } from "../costs/CostTracker.js";
import { estimateMessageTokens } from "../util/tokenEstimate.js";
import { createLogger } from "../util/logger.js";
import type { AgentLoop } from "./AgentLoop.js";
import type { CompactionManager } from "./Compaction.js";
import type { LoopDetector } from "./LoopDetector.js";
import type { AttachmentProcessor } from "./AttachmentProcessor.js";

const log = createLogger("task.runner");

export interface RunOptions {
  readonly input: string;
  readonly sessionId?: string;
  readonly channel?: string;
  readonly channelMeta?: ChannelMeta;
  readonly model?: string;
  /** Voice turns ask the agent to answer in spoken style. */
  readonly voiceMode?: boolean;
  /** Forwarded every event, for SSE emission on the chat route. */
  readonly onLocal?: (event: string, data: unknown) => void;
  /**
   * Files the user sent along with their text. Resolved + inlined via
   * AttachmentProcessor before the agent turn starts: images become
   * inline content parts for multimodal models, audio is transcribed
   * and merged into `input`, documents are text-extracted when
   * possible and otherwise surfaced as "[file: /path]" hints so the
   * agent can reach for read_file / execute_command.
   */
  readonly attachments?: ReadonlyArray<{
    readonly kind: "image" | "audio" | "video" | "document" | "file";
    readonly url?: string;
    readonly path?: string;
    readonly mimeType: string;
    readonly filename?: string;
    readonly size?: number;
    readonly authHeader?: string;
  }>;
}

export interface TerminalState {
  readonly status: "completed" | "failed";
  readonly result?: string;
  readonly error?: string;
}

export interface RunHandle {
  readonly taskId: string;
  readonly sessionId: string;
  readonly done: Promise<TerminalState>;
}

export class TaskRunner {
  /**
   * Abort controllers for every in-flight task, keyed by taskId. Used
   * by `cancel(taskId)` and by Supervisor-initiated kills. The entry
   * is removed once `_execute` finishes (success or fail).
   */
  private readonly inflight = new Map<string, AbortController>();

  /**
   * Reverse index: which task is currently driving each session. Used
   * by `send()` to detect "loop already running on this session — just
   * inject into the pending queue instead of spawning a new parallel
   * loop". Maintained in lockstep with `inflight`.
   */
  private readonly activeBySession = new Map<string, string>();

  constructor(
    private readonly agent: AgentLoop,
    private readonly sessions: SessionStore,
    private readonly tasks: TaskStore,
    private readonly bus: EventBus,
    private readonly hooks?: HookRunner,
    private readonly compaction?: CompactionManager,
    private readonly reviewer?: BackgroundReviewer,
    private readonly dataDir?: string,
    private readonly loopDetector?: LoopDetector,
    private readonly attachments?: AttachmentProcessor,
    private readonly cfg?: ConfigManager,
    private readonly costs?: CostTracker,
  ) {}

  run(opts: RunOptions): RunHandle {
    const taskId = randomUUID();
    const sessionId = this.resolveSession(opts);
    const done = this._execute(taskId, sessionId, opts);
    return { taskId, sessionId, done };
  }

  /**
   * Single entry point for any source that wants to deliver a user
   * message into a session (chat UI, crons, channels, webhooks, voice).
   *
   *   - If a loop is already driving this session: append the message
   *     to the in-memory pending queue and return that existing task's
   *     handle with `mode: "injected"`. The running loop will drain
   *     the pending queue at its next safe boundary (between
   *     streamText calls) and re-issue with the new history.
   *
   *   - If no loop is active on this session: enqueue the message and
   *     spawn a fresh loop. Returns `mode: "fresh"` plus the new task
   *     handle.
   *
   * The pending queue is in-memory only (lost on restart — clients
   * resend). The drain only ever happens at iteration boundaries, so
   * a user message is never appended in the middle of a tool call.
   */
  send(opts: RunOptions): { mode: "fresh" | "injected"; taskId: string; sessionId: string; done?: Promise<TerminalState> } {
    const sessionId = this.resolveSession(opts);
    const activeTaskId = this.activeBySession.get(sessionId);
    if (activeTaskId) {
      this.sessions.enqueuePending(sessionId, {
        text: opts.input,
        source: (opts.channel ? "channel" : "chat") as "chat" | "channel",
        enqueuedAt: Date.now(),
      });
      log.info({ sessionId, activeTaskId, source: opts.channel ?? "chat" }, "input injected into running loop");
      return { mode: "injected", taskId: activeTaskId, sessionId };
    }
    const handle = this.run(opts);
    return { mode: "fresh", taskId: handle.taskId, sessionId: handle.sessionId, done: handle.done };
  }

  /** List every running task id. */
  inflightTaskIds(): readonly string[] {
    return [...this.inflight.keys()];
  }

  /**
   * Abort a running task. Returns true if the task was live and got
   * signalled; false if it had already finished. Supervisor uses this
   * to enforce tool-call rate limits and budget guards.
   */
  cancel(taskId: string, reason = "cancelled"): boolean {
    const ctrl = this.inflight.get(taskId);
    if (!ctrl) return false;
    ctrl.abort(new Error(reason));
    this.bus.emit("task:state", { taskId, status: "failed", error: reason });
    return true;
  }

  private resolveSession(opts: RunOptions): string {
    if (opts.sessionId) {
      if (!this.sessions.getSession(opts.sessionId)) {
        this.sessions.createSessionWithId(opts.sessionId, {
          title: firstLine(opts.input),
          ...(opts.model ? { modelHint: opts.model } : {}),
        });
      }
      return opts.sessionId;
    }
    const s = this.sessions.createSession({
      title: firstLine(opts.input),
      ...(opts.model ? { modelHint: opts.model } : {}),
    });
    return s.id;
  }

  private async _execute(
    taskId: string,
    sessionId: string,
    opts: RunOptions,
  ): Promise<TerminalState> {
    const startedAt = Date.now();
    const emit = (event: string, data: unknown) => {
      opts.onLocal?.(event, data);
    };

    emit("task:state", { status: "running" });
    this.bus.emit("task:state", { taskId, status: "running" });

    if (this.hooks) {
      void this.hooks.run("TaskStart", { taskId, toolInput: { input: opts.input, channel: opts.channel } });
    }

    this.tasks.create(
      taskId,
      sessionId,
      opts.input,
      opts.model,
      opts.channel,
      opts.channelMeta as Record<string, unknown> | undefined,
    );

    // Await any in-flight compaction so the next turn sees the compacted
    // history, not a stale one. Resolve to the (possibly rolled) session id.
    if (this.compaction) {
      await this.compaction.awaitPending(sessionId);
      const rolled = this.compaction.currentSessionId(sessionId);
      if (rolled !== sessionId) {
        // Compaction moved us to a child session — the old cached system
        // prompt doesn't match the new session.
        this.agent.invalidateSystemPromptCache(sessionId);
        sessionId = rolled;
      }
    }

    // If the caller provided file attachments, resolve them into:
    //   - `effectiveInput`: the original user text plus any fallback
    //     hints (audio transcripts, small inlined text files, or
    //     "[file attached: /path]" pointers for docs we couldn't pass
    //     as native parts). Only this current turn sees these hints.
    //   - `userImages` / `userFiles`: provider-native content parts the
    //     model sees alongside text (images + PDFs).
    // Failures never block the turn — the processor returns best-effort.
    let effectiveInput = opts.input;
    let userImages: ReadonlyArray<{ image: Buffer; mimeType: string }> = [];
    let userFiles: ReadonlyArray<{ data: Buffer; mimeType: string; filename?: string }> = [];
    if (this.attachments && opts.attachments && opts.attachments.length > 0) {
      try {
        const processed = await this.attachments.process(opts.input, opts.attachments);
        effectiveInput = processed.text;
        userImages = processed.imageParts.map((p) => ({ image: p.image, mimeType: p.mimeType }));
        userFiles = processed.fileParts.map((p) => ({
          data: p.data,
          mimeType: p.mimeType,
          ...(p.filename ? { filename: p.filename } : {}),
        }));
      } catch (e) {
        log.warn({ err: (e as Error).message, taskId }, "attachment processing errored");
      }
    }

    // Persist the RAW user input to the session — not the hint-enriched
    // variant. The chat UI renders attachments from the sidecar column
    // (see appendMessage below), so the user bubble stays clean without
    // "[file attached: /path]" noise polluting the transcript.
    const userMsg: ModelMessage = { role: "user", content: opts.input };
    // Persist attachment metadata as a sidecar so the UI can re-render
    // image previews / file chips on history hydration. Only locally-
    // resolved paths are stored — url-only attachments (no download
    // yet) are skipped; they're handled upstream by AttachmentProcessor.
    const attachmentMeta: AttachmentMeta[] = (opts.attachments ?? [])
      .filter((a): a is typeof a & { path: string } => typeof a.path === "string" && a.path.length > 0)
      .map((a) => ({
        kind: a.kind,
        path: a.path,
        mimeType: a.mimeType,
        ...(a.filename ? { filename: a.filename } : {}),
        ...(typeof a.size === "number" ? { size: a.size } : {}),
      }));
    this.sessions.appendMessage(
      sessionId,
      userMsg,
      estimateMessageTokens(userMsg),
      attachmentMeta.length > 0 ? { attachments: attachmentMeta } : {},
    );

    let stepCount = 0;
    let toolCallCount = 0;
    // Accumulate token usage across every iteration of the outer loop
    // so a single task that drained pending inputs over multiple
    // streamText calls reports the SUM, not the last one. CostTracker
    // is invoked per-iteration so the cost dashboard sees activity in
    // real time, but TaskStore.complete gets the aggregate at the end.
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let lastToolName = "";
    let lastToolArgs: unknown = null;
    let lastToolStartedAt = 0;

    // Compose a per-task AbortController with a configurable safety
    // timeout (TASK_TIMEOUT_MS setting) so both `cancel(taskId)` and
    // timeout share the same signal. 0 disables the timeout — used by
    // autonomous campaigns that are meant to run indefinitely.
    const abortController = new AbortController();
    const timeoutMs = (this.cfg?.setting("TASK_TIMEOUT_MS") as number | undefined) ?? 0;
    const timeoutHandle = timeoutMs > 0
      ? setTimeout(
          () => abortController.abort(new Error(`task timeout (${Math.round(timeoutMs / 1000)}s)`)),
          timeoutMs,
        ).unref()
      : null;
    this.inflight.set(taskId, abortController);
    this.activeBySession.set(sessionId, taskId);

    // Drive value across iterations. First iteration uses the original
    // user input + attachments. Subsequent iterations are triggered by
    // pending-queue drains and have no attachments (text-only inject).
    let currentUserMessage = effectiveInput;
    let currentImages = userImages;
    let currentFiles = userFiles;
    let lastResult = "";
    let lastModelId = "";

    try {
      let outerIteration = 0;
      // Outer loop: each pass does ONE streamText turn. We drain the
      // in-memory pending queue between turns — at this point the
      // previous turn's assistant + tool messages are fully persisted
      // in session_messages, so appending a `user` message is safe.
      // Mid-stream injects are NEVER applied; they accumulate in the
      // queue and drain here, where the conversation is settled.
      while (true) {
        outerIteration++;

        // Re-read history every iteration. Iter 1: history = everything
        // up to and including the user message we appended at line ~230.
        // Iter 2+: history = everything up to and including the freshly-
        // appended user message we just added from the pending drain.
        const history = this.sessions.getHistory(sessionId, { limit: 40 });
        const priorHistory = history.slice(0, -1);

        const turn = await this.agent.run({
          taskId,
          sessionId,
          userMessage: currentUserMessage,
          history: priorHistory,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.voiceMode ? { voiceMode: true } : {}),
          ...(currentImages.length > 0 ? { userImages: currentImages } : {}),
          ...(currentFiles.length > 0 ? { userFiles: currentFiles } : {}),
          abortSignal: abortController.signal,
        });
        lastModelId = turn.modelId;

        emit("model:called", { iteration: outerIteration, modelId: turn.modelId });

        // Per-iteration text accumulator so each iteration's reply is
        // emitted as its own `text:end` event (one assistant message
        // per iteration in the UI). `reasoningText` is captured
        // separately as a fallback — Gemini 3.x emits its visible
        // answer through the reasoning channel for some turn shapes,
        // which would otherwise leave the UI showing "(no text
        // output)" despite a successful run with N tool calls.
        let assistantText = "";
        let reasoningText = "";

        for await (const ev of turn.eventStream) {
          switch (ev.type) {
            case "text-delta":
              emit("text:delta", { delta: ev.delta });
              this.bus.emit("task:text:delta", { taskId, delta: ev.delta });
              assistantText += ev.delta;
              break;
            case "reasoning-delta":
              reasoningText += ev.delta;
              break;
            case "tool-call":
              toolCallCount++;
              lastToolName = ev.name;
              lastToolArgs = ev.args;
              lastToolStartedAt = Date.now();
              emit("tool:before", { tool_name: ev.name, tool: ev.name, params: ev.args });
              this.bus.emit("task:tool:before", { taskId, name: ev.name, args: ev.args });
              break;
            case "tool-result":
              this.tasks.recordToolCall(taskId, ev.name, lastToolArgs, ev.result, undefined, Date.now() - lastToolStartedAt);
              emit("tool:after", { tool_name: ev.name, tool: ev.name, result: ev.result });
              this.bus.emit("task:tool:after", {
                taskId,
                name: ev.name,
                result: ev.result,
                durationMs: Date.now() - lastToolStartedAt,
              });
              break;
            case "tool-error":
              this.tasks.recordToolCall(taskId, ev.name, lastToolArgs, undefined, ev.message, Date.now() - lastToolStartedAt);
              emit("tool:after", { tool_name: ev.name, tool: ev.name, error: ev.message });
              this.bus.emit("task:tool:after", {
                taskId,
                name: ev.name,
                error: ev.message,
                durationMs: Date.now() - lastToolStartedAt,
              });
              break;
            case "step-finish":
              stepCount++;
              break;
            case "error": {
              const err = ev.message;
              this.tasks.fail(taskId, err, Date.now() - startedAt);
              emit("task:state", { status: "failed", error: err });
              this.bus.emit("task:state", { taskId, status: "failed", error: err });
              this.bus.emit("task:reply:needed", {
                taskId,
                channel: opts.channel ?? "",
                channelMeta: (opts.channelMeta ?? {}) as ChannelMeta,
                text: `Sorry, I encountered an error: ${err}`,
                failed: true,
              });
              return { status: "failed", error: err };
            }
            case "finish": {
              const inputTokens = ev.inputTokens ?? 0;
              const outputTokens = ev.outputTokens ?? 0;
              totalInputTokens += inputTokens;
              totalOutputTokens += outputTokens;
              if (this.costs && (inputTokens > 0 || outputTokens > 0)) {
                const [provider] = turn.modelId.split(":", 2);
                const modelName = turn.modelId.slice((provider?.length ?? 0) + 1);
                try {
                  this.costs.record(taskId, modelName, provider ?? "unknown", inputTokens, outputTokens);
                } catch (e) {
                  log.warn({ err: (e as Error).message, taskId }, "cost record failed");
                }
              }
              break;
            }
          }
        }

        // Stream is now fully drained → assistant + tool calls + tool
        // results are all available via `turn.responseMessages()`.
        // Persist them as one block, then we are at the safe boundary
        // where new user messages can legally be appended.
        const responseMessages = await turn.responseMessages();
        for (const msg of responseMessages) {
          this.sessions.appendMessage(sessionId, msg, estimateMessageTokens(msg));
        }

        // Schedule background compaction + learning review — per-iteration.
        if (this.compaction && this.dataDir) {
          this.compaction.maybeCompactInBackground(sessionId, {
            contextWindow: this.agent.models.contextWindow(turn.modelId),
            dataDir: this.dataDir,
          });
        }
        if (this.reviewer) this.reviewer.onTurnComplete(sessionId);

        // Prefer real assistant text. If the model only produced
        // reasoning (Gemini thinking chain) plus tool calls without a
        // user-facing summary, surface the reasoning so the user sees
        // *something* rather than "(no text output)". If both are
        // empty (model hit step limit mid tool-loop), fall back to a
        // status string so the UI doesn't render an empty bubble.
        const iterationResult = assistantText
          || (reasoningText ? reasoningText.trim() : "")
          || (toolCallCount > 0 ? `(completed ${toolCallCount} tool calls without final summary)` : "(no text output)");
        lastResult = iterationResult;

        // Emit the per-iteration assistant final text. UI renders this as
        // a complete assistant message in the conversation.
        emit("text:end", { finalText: iterationResult });
        this.bus.emit("task:text:end", { taskId, finalText: iterationResult });

        // SAFE BOUNDARY: previous turn fully resolved. Drain pending
        // (user inputs that arrived during this iteration). If empty,
        // we are done. If not, continue with a fresh streamText turn
        // whose user message is the coalesced pending text.
        if (!this.sessions.hasPending(sessionId)) {
          break;
        }
        const pending = this.sessions.drainPending(sessionId);
        // Coalesce all queued texts into a SINGLE user turn. Multiple
        // consecutive user messages have provider-specific quirks
        // (Anthropic coalesces them, OpenAI accepts them). One message
        // is universally safe.
        currentUserMessage = pending.map((p) => p.text).join("\n\n");
        currentImages = [];
        currentFiles = [];
        const injectedUserMsg: ModelMessage = { role: "user", content: currentUserMessage };
        this.sessions.appendMessage(sessionId, injectedUserMsg, estimateMessageTokens(injectedUserMsg));
        log.info(
          { taskId, sessionId, iteration: outerIteration, drained: pending.length },
          "drained pending into history; starting next iteration",
        );
      }

      this.tasks.complete(taskId, {
        result: lastResult,
        toolCalls: toolCallCount,
        steps: stepCount,
        durationMs: Date.now() - startedAt,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      });

      emit("task:state", { status: "completed", result: lastResult });
      this.bus.emit("task:state", { taskId, status: "completed", result: lastResult });

      if (opts.channel) {
        this.bus.emit("task:reply:needed", {
          taskId,
          channel: opts.channel,
          channelMeta: (opts.channelMeta ?? {}) as ChannelMeta,
          text: lastResult,
          failed: false,
        });
      }

      return { status: "completed", result: lastResult };
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      log.error({ taskId, err: msg }, "task crashed");
      this.tasks.fail(taskId, msg, Date.now() - startedAt);
      emit("task:state", { status: "failed", error: msg });
      this.bus.emit("task:state", { taskId, status: "failed", error: msg });
      if (opts.channel) {
        this.bus.emit("task:reply:needed", {
          taskId,
          channel: opts.channel,
          channelMeta: (opts.channelMeta ?? {}) as ChannelMeta,
          text: `Sorry, I encountered an error: ${msg}`,
          failed: true,
        });
      }
      return { status: "failed", error: msg };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.inflight.delete(taskId);
      this.activeBySession.delete(sessionId);
      this.loopDetector?.cleanup(taskId);
      void lastToolName;
      void lastModelId;
      if (this.hooks) {
        void this.hooks.run("TaskEnd", { taskId, toolOutput: { channel: opts.channel } });
      }
    }
  }
}

function firstLine(msg: string): string {
  const first = msg.trim().split(/\r?\n/, 1)[0] ?? msg;
  return first.slice(0, 80) || "New chat";
}
