/**
 * Compaction — hermes-pattern background context compression.
 *
 * Triggered when a session's estimated token count approaches the
 * model's context window (threshold = min(contextWindow * 0.5,
 * contextWindow - 20_000)). Runs in the background — the next turn
 * awaits any pending compaction before building messages.
 *
 * Steps:
 *   1. Anti-thrashing check (skip if last 2 passes saved <10%).
 *   2. Protect first 3 messages + tail (~4k tokens).
 *   3. Pre-prune: truncate / persist-to-disk huge tool outputs.
 *   4. Summarise the pruned middle with the cheap model, structured
 *      template: Resolved / Pending / Active Task / Files / Prefs.
 *   5. Create a child session linked to the parent (compaction chain).
 *   6. Copy the summary + tail messages to the child session; the
 *      original session stays intact for audit.
 *
 * The caller receives the new sessionId to continue the conversation on.
 */

import { generateText, type ModelMessage } from "ai";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { EventBus } from "../events/eventBus.js";
import type { SessionStore, SessionRow, MessageRow } from "../memory/SessionStore.js";
import type { ModelRouter } from "../models/ModelRouter.js";
import { createLogger } from "../util/logger.js";
import { msgText } from "../util/msgText.js";
import { estimateTokens } from "../util/tokenEstimate.js";

const log = createLogger("core.compaction");

const PROTECT_HEAD = 3;
const PROTECT_TAIL_TOKENS = 4_000;
const TOOL_OUTPUT_MAX = 5_000;
const TOOL_OUTPUT_PERSIST = 50_000;
const SUMMARY_MAX_TOKENS = 1_500;
const MIN_SAVINGS_PCT = 10;

export interface CompactionContext {
  /** Model's advertised context window (tokens). */
  readonly contextWindow: number;
  /** Path to write large tool outputs to (relative to data dir). */
  readonly dataDir: string;
}

export interface CompactionResult {
  readonly triggered: boolean;
  readonly newSessionId?: string;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly savingsPct?: number;
  readonly skippedReason?: string;
}

/** Per-session state: pending promise + recent-savings rolling window. */
interface SessionState {
  pending: Promise<CompactionResult> | null;
  recentSavings: number[];
  latestSessionId: string;
}

export class CompactionManager {
  private readonly state = new Map<string, SessionState>();

  constructor(
    private readonly sessions: SessionStore,
    private readonly models: ModelRouter,
    private readonly bus?: EventBus,
  ) {}

  /**
   * The session id a new turn should READ/WRITE from. Compaction may
   * have rolled the session to a child; callers track the latest id
   * here instead of holding a stale reference.
   */
  currentSessionId(originalId: string): string {
    const st = this.state.get(originalId);
    return st?.latestSessionId ?? originalId;
  }

  /** Block on any in-flight compaction for this session. No-op if none. */
  async awaitPending(sessionId: string): Promise<void> {
    const st = this.state.get(sessionId);
    if (st?.pending) {
      try { await st.pending; } catch { /* failures shouldn't block the turn */ }
    }
  }

  /**
   * Check context pressure; if over threshold, kick off compaction in
   * the background (no await). Returns immediately.
   */
  maybeCompactInBackground(sessionId: string, ctx: CompactionContext): void {
    const threshold = Math.min(ctx.contextWindow * 0.5, ctx.contextWindow - 20_000);
    const session = this.sessions.getSession(sessionId);
    if (!session) return;
    const tokens = session.totalTokens > 0
      ? session.totalTokens
      : estimateTokens(
          this.sessions.getMessagesAsConversation(sessionId)
            .map((m) => msgText(m.content)).join("\n"),
        );
    if (tokens < threshold) return;

    const st = this.getOrCreateState(sessionId);
    if (st.pending) return; // already in flight

    log.info({ sessionId, tokens, threshold, contextWindow: ctx.contextWindow }, "compaction scheduled");
    this.bus?.emit("compact:triggered", { sessionId, tokens, threshold });
    st.pending = this.runCompaction(sessionId, ctx, tokens).finally(() => {
      const s = this.state.get(sessionId);
      if (s) s.pending = null;
    });
  }

  private getOrCreateState(sessionId: string): SessionState {
    let s = this.state.get(sessionId);
    if (!s) {
      s = { pending: null, recentSavings: [], latestSessionId: sessionId };
      this.state.set(sessionId, s);
    }
    return s;
  }

  private async runCompaction(
    sessionId: string,
    ctx: CompactionContext,
    tokensBefore: number,
  ): Promise<CompactionResult> {
    const st = this.getOrCreateState(sessionId);

    // Anti-thrashing: if the last two passes saved <10%, skip.
    const recent = st.recentSavings.slice(-2);
    if (recent.length >= 2 && recent.every((s) => s < MIN_SAVINGS_PCT)) {
      log.info({ sessionId, recent }, "compaction skipped (anti-thrashing)");
      this.bus?.emit("compact:skipped", { sessionId, reason: "anti_thrashing" });
      return { triggered: false, skippedReason: "anti_thrashing" };
    }

    const session = this.sessions.getSession(sessionId);
    if (!session) return { triggered: false, skippedReason: "session_not_found" };

    const messages = this.sessions.getMessagesFull(sessionId);
    if (messages.length < PROTECT_HEAD + 4) {
      return { triggered: false, skippedReason: "too_short" };
    }

    // Split into head (protected), middle (compact), tail (protected by token budget)
    const head = messages.slice(0, PROTECT_HEAD);
    const { tail, middle } = splitTailByTokenBudget(messages.slice(PROTECT_HEAD), PROTECT_TAIL_TOKENS);

    if (middle.length === 0) return { triggered: false, skippedReason: "nothing_to_compact" };

    // Pre-prune giant tool outputs
    const prunedMiddle = middle.map((m, i) => pruneLargeToolOutput(m, ctx.dataDir, sessionId, i));

    // Summarise the middle
    let summary: string;
    try {
      summary = await this.buildSummary(prunedMiddle);
    } catch (e) {
      log.warn({ sessionId, err: (e as Error).message }, "summary failed — falling back to prune-only");
      summary = `(summary unavailable — ${prunedMiddle.length} older messages pruned)`;
    }

    // Create child session + persist head, summary marker, tail
    const child = this.sessions.createChildSession(session.id, {
      title: session.title,
      ...(session.modelHint ? { modelHint: session.modelHint } : {}),
      ...(session.source ? { source: session.source } : {}),
      ...(session.userId ? { userId: session.userId } : {}),
      ...(session.systemPrompt ? { systemPrompt: session.systemPrompt } : {}),
    });

    for (const m of head) {
      this.sessions.appendMessage(child.id, JSON.parse(m.contentJson) as ModelMessage, m.tokenCount);
    }
    const summaryMsg: ModelMessage = {
      role: "system",
      content: [
        "<conversation-summary>",
        "The following is a summary of earlier conversation compacted to save context:",
        "",
        summary,
        "</conversation-summary>",
      ].join("\n"),
    };
    this.sessions.appendMessage(child.id, summaryMsg, estimateTokens(summary));
    for (const m of tail) {
      this.sessions.appendMessage(child.id, JSON.parse(m.contentJson) as ModelMessage, m.tokenCount);
    }

    const tokensAfter = (this.sessions.getSession(child.id)?.totalTokens) ?? estimateTokens(summary);
    const savingsPct = tokensBefore > 0 ? Math.round(((tokensBefore - tokensAfter) / tokensBefore) * 100) : 0;
    st.recentSavings.push(savingsPct);
    if (st.recentSavings.length > 4) st.recentSavings.shift();
    st.latestSessionId = child.id;

    log.info({
      sessionId, newSessionId: child.id, tokensBefore, tokensAfter, savingsPct,
    }, "compaction complete");
    this.bus?.emit("compact:completed", {
      sessionId, newSessionId: child.id, tokensBefore, tokensAfter, savingsPct,
    });
    return {
      triggered: true,
      newSessionId: child.id,
      tokensBefore,
      tokensAfter,
      savingsPct,
    };
  }

  private async buildSummary(messages: readonly MessageRow[]): Promise<string> {
    const cheap = await this.models.getCheap();
    const transcript = messages
      .map((m) => {
        const parsed = JSON.parse(m.contentJson) as ModelMessage;
        return `[${m.role}] ${msgText(parsed.content).slice(0, 2000)}`;
      })
      .join("\n---\n");

    const system = [
      "You are compacting a conversation before it exceeds the model's context.",
      "Produce a STRUCTURED summary using exactly these sections:",
      "  ## Resolved",
      "  ## Pending",
      "  ## Active Task",
      "  ## Files & Decisions",
      "  ## User Preferences",
      "Preserve: commands run, file paths touched, errors and how they were resolved,",
      "user-stated constraints, and any half-finished work. Be concise but specific.",
    ].join(" ");

    const { text } = await generateText({
      model: cheap.model,
      system,
      prompt: `Conversation to summarise:\n\n${transcript}`,
      temperature: 0.1,
    });
    return text.trim();
  }
}

function splitTailByTokenBudget(
  rest: readonly MessageRow[],
  budgetTokens: number,
): { tail: readonly MessageRow[]; middle: readonly MessageRow[] } {
  let used = 0;
  const tailRev: MessageRow[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const m = rest[i]!;
    const toks = m.tokenCount > 0
      ? m.tokenCount
      : estimateTokens(msgText((JSON.parse(m.contentJson) as ModelMessage).content));
    if (used + toks > budgetTokens && tailRev.length >= 2) break;
    tailRev.push(m);
    used += toks;
  }
  tailRev.reverse();
  const middleCount = rest.length - tailRev.length;
  return {
    tail: tailRev,
    middle: rest.slice(0, middleCount),
  };
}

function pruneLargeToolOutput(
  m: MessageRow,
  dataDir: string,
  sessionId: string,
  stepIndex: number,
): MessageRow {
  if (m.role !== "tool") return m;
  const parsed = JSON.parse(m.contentJson) as ModelMessage;
  const text = msgText(parsed.content);
  if (text.length <= TOOL_OUTPUT_MAX) return m;

  // The tool role's content must be a ToolContent array (not a plain
  // string). Build the replacement as a generic object and serialise —
  // consumers parse it back through the SDK which validates shape.
  if (text.length > TOOL_OUTPUT_PERSIST) {
    const outDir = join(dataDir, "tool-outputs");
    try { mkdirSync(outDir, { recursive: true }); } catch {}
    const file = join(outDir, `${sessionId}-step${stepIndex}-${Date.now()}.txt`);
    try { writeFileSync(file, text, "utf-8"); } catch {}
    const replaced = {
      ...parsed,
      content: [{ type: "tool-result", toolCallId: "compacted", toolName: "compacted",
        output: { type: "text", value: `[Tool output (${text.length} chars) saved to disk: ${file}]` } }],
    };
    return { ...m, contentJson: JSON.stringify(replaced) };
  }

  const head = Math.floor(TOOL_OUTPUT_MAX * 0.6);
  const tail = Math.floor(TOOL_OUTPUT_MAX * 0.3);
  const truncated = `${text.slice(0, head)}\n\n[… truncated ${text.length - head - tail} chars …]\n\n${text.slice(-tail)}`;
  const replaced = {
    ...parsed,
    content: [{ type: "tool-result", toolCallId: "compacted", toolName: "compacted",
      output: { type: "text", value: truncated } }],
  };
  return { ...m, contentJson: JSON.stringify(replaced) };
}

// Exposed for tests / external callers
export { SessionRow };
