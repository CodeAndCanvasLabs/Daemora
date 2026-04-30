/**
 * BackgroundReviewer — hermes-pattern autonomous learning loop.
 *
 * Every N turns (default 10), after the main agent finishes a response,
 * we fork a second run of the AgentLoop with a narrow toolset (memory +
 * skill_manage) and the full conversation history. The forked agent's
 * job is to scan what just happened and save anything durable:
 *   - User preferences revealed → memory(add, target=user)
 *   - Environment facts discovered → memory(add, target=memory)
 *   - Reusable workflow perfected → skill_manage(create|patch)
 *
 * The reviewer runs fire-and-forget (setImmediate chain). Main agent
 * never sees the review prompt; the user never waits for it.
 */

import { stepCountIs, streamText, type ModelMessage } from "ai";

import type { AgentLoop } from "../core/AgentLoop.js";
import type { EventBus } from "../events/eventBus.js";
import type { SessionStore } from "../memory/SessionStore.js";
import { toAiTool, type ToolContext } from "../tools/types.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("learning.reviewer");

const REVIEW_TOOLSET: ReadonlySet<string> = new Set([
  "memory", "skill_manage", "skill_view", "memory_save", "memory_recall",
]);

const DEFAULT_NUDGE_INTERVAL = 10;
const DEFAULT_MIN_TURNS = 6;
const DEFAULT_MAX_STEPS = 8;

const MEMORY_REVIEW_PROMPT = [
  "Review the conversation above and consider saving to declarative memory if appropriate.",
  "",
  "Focus on:",
  "1. Has the user revealed things about themselves — their persona, desires, preferences, or personal details worth remembering?",
  "2. Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate?",
  "",
  "If something stands out, save it using the `memory` tool (action='add', target='user' or 'memory'). ",
  "Write declarative facts ('User prefers concise responses'), NOT instructions to yourself.",
  "If nothing is worth saving, just say 'Nothing to save.' and stop.",
].join("\n");

const SKILL_REVIEW_PROMPT = [
  "Review the conversation above and consider saving or updating a skill if appropriate.",
  "",
  "Focus on: was a non-trivial approach used to complete a task that required trial and error, ",
  "changing course due to findings, or did the user expect or desire a different method or outcome?",
  "",
  "If a relevant skill already exists, patch it (skill_manage action='patch') with what you learned. ",
  "Otherwise, create a new skill if the approach is reusable.",
  "If nothing is worth saving, just say 'Nothing to save.' and stop.",
].join("\n");

const COMBINED_REVIEW_PROMPT = [
  "Review the conversation above and consider two things:",
  "",
  "**Memory**: Has the user revealed things about themselves — persona, desires, preferences? ",
  "If so, save with the `memory` tool.",
  "",
  "**Skills**: Was a non-trivial approach used that required trial and error or was worth codifying? ",
  "If a relevant skill exists, patch it. Otherwise create one with `skill_manage`.",
  "",
  "Only act if there's something genuinely worth saving. If nothing stands out, say 'Nothing to save.' and stop.",
].join("\n");

export interface ReviewerDeps {
  readonly agent: AgentLoop;
  readonly sessions: SessionStore;
  readonly bus?: EventBus;
  /** Override for testing. */
  readonly nudgeInterval?: number;
  readonly minTurns?: number;
  readonly maxSteps?: number;
}

export class BackgroundReviewer {
  /** Per-session turn counter since last review. */
  private readonly turnsSince = new Map<string, number>();
  private readonly nudgeInterval: number;
  private readonly minTurns: number;
  private readonly maxSteps: number;

  constructor(private readonly deps: ReviewerDeps) {
    this.nudgeInterval = deps.nudgeInterval ?? DEFAULT_NUDGE_INTERVAL;
    this.minTurns = deps.minTurns ?? DEFAULT_MIN_TURNS;
    this.maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  }

  /**
   * Called after the main agent finishes a turn. Increments the turn
   * counter and, if the threshold is reached, schedules a review.
   */
  onTurnComplete(sessionId: string): void {
    const turns = (this.turnsSince.get(sessionId) ?? 0) + 1;
    this.turnsSince.set(sessionId, turns);
    if (turns < Math.max(this.nudgeInterval, this.minTurns)) return;
    this.turnsSince.set(sessionId, 0);

    // Fire-and-forget. Errors are logged, never thrown.
    setImmediate(() => {
      this.review(sessionId, "combined").catch((e) =>
        log.warn({ sessionId, err: (e as Error).message }, "background review failed"),
      );
    });
  }

  /** Manual trigger — same plumbing as auto. */
  async review(
    sessionId: string,
    kind: "memory" | "skill" | "combined",
  ): Promise<void> {
    const session = this.deps.sessions.getSession(sessionId);
    if (!session) return;

    const messages = this.deps.sessions.getMessagesAsConversation(sessionId);
    if (messages.length < this.minTurns) return;

    const prompt = kind === "memory" ? MEMORY_REVIEW_PROMPT
      : kind === "skill" ? SKILL_REVIEW_PROMPT
      : COMBINED_REVIEW_PROMPT;

    this.deps.bus?.emit("review:started", { sessionId, kind });
    const reviewHistory: ModelMessage[] = [...messages, { role: "user", content: prompt }];

    // Forked agent — reuse the parent's AgentLoop instance but narrow
    // the tool visibility to the review toolset.
    const toolDefs = this.deps.agent.tools.list().filter((t) => REVIEW_TOOLSET.has(t.name));
    if (toolDefs.length === 0) {
      log.warn({ sessionId }, "no review-capable tools registered — skipping");
      return;
    }
    const ctxFactory = (signal: AbortSignal): ToolContext => ({
      abortSignal: signal,
      taskId: `${sessionId}/review`,
      logger: {
        info: (msg, ctx) => log.info({ sessionId, ...ctx }, msg),
        warn: (msg, ctx) => log.warn({ sessionId, ...ctx }, msg),
        error: (msg, ctx) => log.error({ sessionId, ...ctx }, msg),
      },
    });
    const aiTools = Object.fromEntries(toolDefs.map((t) => [t.name, toAiTool(t, ctxFactory)]));

    let resolvedModel;
    try {
      resolvedModel = await this.deps.agent.models.getCheap();
    } catch (e) {
      log.warn({ sessionId, err: (e as Error).message }, "no cheap model for review — skipping");
      return;
    }

    const stream = streamText({
      model: resolvedModel.model,
      system:
        "You are a learning-review agent. Your only job is to scan the conversation " +
        "and save anything durable via the memory/skill tools. Do NOT answer, explain, " +
        "or carry on the conversation. If nothing stands out, just say 'Nothing to save.' and stop.",
      messages: reviewHistory,
      tools: aiTools,
      stopWhen: stepCountIs(this.maxSteps),
    });

    let saves = 0;
    for await (const part of stream.fullStream as AsyncIterable<{ type: string }>) {
      if (part.type === "tool-call") saves++;
    }
    if (saves > 0) {
      log.info({ sessionId, saves }, "background review saved entries");
    }
    this.deps.bus?.emit("review:completed", { sessionId, saves });
  }
}
