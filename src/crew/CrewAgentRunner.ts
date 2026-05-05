/**
 * CrewAgentRunner — executes one `useCrew(crewId, task)` call.
 *
 * Sub-agent execution model:
 *   - A fresh AI SDK streamText run with a scoped tool set — only the
 *     tools the crew manifest actually whitelists (and that exist in
 *     the host ToolRegistry).
 *   - Persistent session id `crew:<crewId>` so the crew accumulates its
 *     own working memory across calls in the same workday.
 *   - Blocking — the runner returns only after the crew finishes. That
 *     keeps the main agent's tool call semantics simple: one call in,
 *     one result out, tool errors propagate as DaemoraError.
 *
 * Delegation contract:
 *   - The tool-facing schema (use_crew) requires task + context +
 *     constraints + successCriteria. The runner accepts them as optional
 *     so internal callers (teams, webhooks, watchers, channels) can keep
 *     passing a single `task` string. When the rich fields are present,
 *     they get formatted into an XML-tagged user message so the crew
 *     sees a structured contract instead of a wall of prose.
 *
 * Forced summary:
 *   - Crews regularly returned `text:""` when the model hit the step
 *     ceiling on a tool-call and never wrote a final reply. After the
 *     primary stream finishes, if no text was produced we run a single
 *     follow-up turn that asks for a plain-text summary, capped once
 *     per delegation.
 *
 * What this deliberately does NOT do:
 *   - Stream deltas to the outer SSE — the main agent gets the final
 *     answer, not the crew's thought process. Crew internals stay inside
 *     the crew's session.
 *   - Spawn nested crews. A crew calling useCrew() would recurse
 *     unbounded; the tool is filtered out of the crew's toolset.
 */

import { stepCountIs, streamText, type ModelMessage } from "ai";

import type { ModelRouter } from "../models/ModelRouter.js";
import type { SessionStore } from "../memory/SessionStore.js";
import type { SkillRegistry } from "../skills/SkillRegistry.js";
import type { ToolRegistry } from "../tools/registry.js";
import { toAiTool, type ToolContext } from "../tools/types.js";
import { NotFoundError, toDaemoraError } from "../util/errors.js";
import { createLogger } from "../util/logger.js";
import { estimateMessageTokens } from "../util/tokenEstimate.js";
import type { CrewRegistry } from "./CrewRegistry.js";
import type { LoadedCrew } from "./types.js";

const log = createLogger("crew.runner");

/** Max tool-call iterations inside a crew. High enough that real work doesn't fail mid-flow. */
const DEFAULT_CREW_MAX_STEPS = 60;

/** Forced-summary follow-up budget. One short turn to produce the final reply. */
const SUMMARY_FOLLOWUP_STEPS = 2;

/** Tools a crew may NEVER see, regardless of manifest. Prevents recursion. */
const NEVER_ALLOWED: ReadonlySet<string> = new Set(["use_crew", "parallel_crew"]);

/**
 * Tools every crew gets, regardless of manifest — the learning substrate.
 * skill_view lets sub-agents read the same skill library the main agent
 * has; skill_manage lets a specialist crew save or patch a skill it just
 * perfected (hermes pattern). Memory tools are additive — a crew that
 * discovers a user preference should persist it.
 */
const ALWAYS_CREW_TOOLS: ReadonlySet<string> = new Set([
  "skill_view", "skill_manage", "memory_save", "memory_recall",
]);

export interface CrewReference {
  readonly kind: "file" | "url" | "note";
  readonly value: string;
  readonly why?: string | undefined;
}

export interface CrewRunInput {
  readonly crewId: string;
  readonly task: string;
  /** Background the crew can't see otherwise. Optional for internal callers. */
  readonly context?: string;
  /** Hard limits the crew must respect. Optional for internal callers. */
  readonly constraints?: string;
  /** What "done" looks like + how it'll be verified. Optional for internal callers. */
  readonly successCriteria?: string;
  /** Source material (files, URLs, notes). Optional. */
  readonly references?: readonly CrewReference[];
  readonly parentTaskId: string;
  readonly parentModelId: string;
  readonly maxSteps?: number;
  readonly abortSignal: AbortSignal;
}

export interface CrewRunResult {
  readonly crewId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly toolCalls: number;
  readonly steps: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export class CrewAgentRunner {
  /** Process-lifetime map: crewId → sessionId. Sessions persist in SQL regardless. */
  private readonly crewSessionIds = new Map<string, string>();

  constructor(
    private readonly crews: CrewRegistry,
    private readonly tools: ToolRegistry,
    private readonly models: ModelRouter,
    private readonly sessions: SessionStore,
    private readonly skills?: SkillRegistry,
  ) {}

  async run(input: CrewRunInput): Promise<CrewRunResult> {
    const crew = this.crews.tryGet(input.crewId);
    if (!crew) {
      throw new NotFoundError(`Unknown crew: ${input.crewId}`, {
        knownCrews: this.crews.list().map((c) => c.manifest.id),
      });
    }

    // Same crew should reuse its session across calls AND across
    // server restarts so it accumulates context instead of being
    // orphaned on every process boot. Lookup strategy:
    //   1. Process-lifetime cache (hot path — same server run).
    //   2. DB lookup by stable `source = "crew:<id>"` tag under the
    //      main parent session (survives restarts).
    //   3. Fall through to creating a fresh row.
    // The crew session is always parented under "main" so the Logs /
    // Chat UI can thread a crew run back to the top-level conversation
    // instead of it floating as an orphan.
    const sourceTag = `crew:${crew.manifest.id}`;
    const parentSessionId = "main";
    const cached = this.crewSessionIds.get(crew.manifest.id);
    let reused = cached ? this.sessions.getSession(cached) : null;
    if (!reused) {
      reused = this.sessions.findLatestSessionBySource(sourceTag, parentSessionId);
    }
    const session = reused ?? this.sessions.createSession({
      title: `Crew: ${crew.manifest.name}`,
      parentSessionId,
      source: sourceTag,
      ...(crew.manifest.profile.model ? { modelHint: crew.manifest.profile.model } : {}),
    });
    this.crewSessionIds.set(crew.manifest.id, session.id);
    const history = this.sessions.getHistory(session.id, { limit: 40 });

    // Persist the delegating task up front so a mid-stream disconnect
    // still leaves the user-visible delegation recorded.
    const userMsgContent = formatDelegationMessage(input);
    const userMsg: ModelMessage = { role: "user", content: userMsgContent };
    this.sessions.appendMessage(session.id, userMsg, estimateMessageTokens(userMsg));

    const crewToolset = this.buildCrewTools(crew, input);
    const resolved = await this.models.resolve(
      crew.manifest.profile.model ?? input.parentModelId,
    );
    const skillsIndex = this.skills
      ? this.skills.renderIndexForPrompt({
          availableTools: new Set(Object.keys(crewToolset)),
          enabledIntegrations: new Set<string>(),
        })
      : "";
    const systemPrompt = buildCrewSystemPrompt(crew, skillsIndex);

    log.info(
      {
        crewId: crew.manifest.id,
        sessionId: session.id,
        modelId: resolved.id,
        toolCount: Object.keys(crewToolset).length,
        dropped: crew.droppedTools,
        historyMessages: history.length,
        hasContext: Boolean(input.context),
        hasConstraints: Boolean(input.constraints),
        hasSuccessCriteria: Boolean(input.successCriteria),
        referenceCount: input.references?.length ?? 0,
      },
      "crew run starting",
    );

    const runStream = async (
      messages: ModelMessage[],
      stepBudget: number,
    ): Promise<{
      text: string;
      toolCalls: number;
      steps: number;
      inputTokens: number;
      outputTokens: number;
      respMessages: ModelMessage[];
    }> => {
      const stream = streamText({
        model: resolved.model,
        system: systemPrompt,
        messages,
        tools: crewToolset,
        temperature: crew.manifest.profile.temperature,
        stopWhen: stepCountIs(stepBudget),
        abortSignal: input.abortSignal,
      });

      let toolCalls = 0;
      let steps = 0;
      let streamError: string | null = null;
      try {
        for await (const part of stream.fullStream as AsyncIterable<{ type: string; [k: string]: unknown }>) {
          if (part.type === "tool-call") {
            toolCalls++;
            const p = part as unknown as { toolName?: string; args?: unknown; input?: unknown };
            log.info(
              { crewId: crew.manifest.id, step: steps, tool: p.toolName ?? "?", argsPreview: previewArgs(p) },
              "crew tool-call",
            );
          } else if (part.type === "tool-result") {
            const p = part as unknown as { toolName?: string; result?: unknown; output?: unknown };
            log.info(
              {
                crewId: crew.manifest.id,
                step: steps,
                tool: p.toolName ?? "?",
                resultPreview: previewResult(p),
              },
              "crew tool-result",
            );
          } else if (part.type === "finish-step") {
            steps++;
          } else if (part.type === "error") {
            streamError = (part as { error?: { message?: string } }).error?.message ?? "stream error";
          }
        }
      } catch (e) {
        streamError = toDaemoraError(e).message;
      }

      if (streamError !== null) {
        log.error({ crewId: crew.manifest.id, error: streamError }, "crew run failed");
        throw toDaemoraError(new Error(streamError));
      }

      const resp = await stream.response;
      const text = await stream.text;
      const usage = await stream.totalUsage;

      return {
        text,
        toolCalls,
        steps,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        respMessages: resp.messages as ModelMessage[],
      };
    };

    const primaryBudget = input.maxSteps ?? DEFAULT_CREW_MAX_STEPS;
    const primary = await runStream([...history, userMsg], primaryBudget);

    for (const m of primary.respMessages) {
      this.sessions.appendMessage(session.id, m, estimateMessageTokens(m));
    }

    let finalText = primary.text;
    let totalToolCalls = primary.toolCalls;
    let totalSteps = primary.steps;
    let totalInputTokens = primary.inputTokens;
    let totalOutputTokens = primary.outputTokens;

    // Forced-summary retry: crews sometimes hit the ceiling on a tool-call
    // and never produce a final text reply. Without a summary the main
    // agent has no idea what was done or what failed. One synthetic turn
    // to extract the summary, capped to a tiny step budget so we don't
    // accidentally let the crew start a new sub-task.
    if (finalText.trim() === "") {
      log.warn(
        {
          crewId: crew.manifest.id,
          steps: totalSteps,
          toolCalls: totalToolCalls,
        },
        "crew returned empty text — forcing summary",
      );
      const synthMsg: ModelMessage = {
        role: "user",
        content:
          "Your previous turn ended without a final reply. Summarise plainly: what you did, what worked, what failed, what's left, and the deliverable (path/URL/exact text). Reply in plain text only — do NOT call any more tools.",
      };
      this.sessions.appendMessage(session.id, synthMsg, estimateMessageTokens(synthMsg));

      const followupHistory: ModelMessage[] = [
        ...history,
        userMsg,
        ...primary.respMessages,
        synthMsg,
      ];
      const followup = await runStream(followupHistory, SUMMARY_FOLLOWUP_STEPS);

      for (const m of followup.respMessages) {
        this.sessions.appendMessage(session.id, m, estimateMessageTokens(m));
      }

      finalText = followup.text;
      totalToolCalls += followup.toolCalls;
      totalSteps += followup.steps;
      totalInputTokens += followup.inputTokens;
      totalOutputTokens += followup.outputTokens;
    }

    log.info(
      {
        crewId: crew.manifest.id,
        sessionId: session.id,
        steps: totalSteps,
        toolCalls: totalToolCalls,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        textLen: finalText.length,
      },
      "crew run finished",
    );

    return {
      crewId: crew.manifest.id,
      sessionId: session.id,
      text: finalText,
      toolCalls: totalToolCalls,
      steps: totalSteps,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    };
  }

  private buildCrewTools(crew: LoadedCrew, input: CrewRunInput): Record<string, ReturnType<typeof toAiTool>> {
    const ctxFactory = (signal: AbortSignal): ToolContext => ({
      abortSignal: signal,
      taskId: `${input.parentTaskId}/crew:${crew.manifest.id}`,
      logger: {
        info: (msg, ctx) => log.info({ crew: crew.manifest.id, ...ctx }, msg),
        warn: (msg, ctx) => log.warn({ crew: crew.manifest.id, ...ctx }, msg),
        error: (msg, ctx) => log.error({ crew: crew.manifest.id, ...ctx }, msg),
      },
    });

    const entries: [string, ReturnType<typeof toAiTool>][] = [];
    const included = new Set<string>();
    for (const name of crew.resolvedTools) {
      if (NEVER_ALLOWED.has(name)) continue;
      const def = this.tools.get(name);
      if (!def) continue; // Tool was unregistered since load — skip silently.
      entries.push([name, toAiTool(def, ctxFactory)]);
      included.add(name);
    }
    // Always include the learning substrate (skill_view, skill_manage,
    // memory tools) so crews can read/write the shared skill + memory
    // library — hermes pattern where every agent fork has full access.
    for (const name of ALWAYS_CREW_TOOLS) {
      if (included.has(name) || NEVER_ALLOWED.has(name)) continue;
      const def = this.tools.get(name);
      if (!def) continue;
      entries.push([name, toAiTool(def, ctxFactory)]);
    }
    return Object.fromEntries(entries);
  }
}

function buildCrewSystemPrompt(crew: LoadedCrew, skillsIndex: string): string {
  const lines = [
    crew.manifest.profile.systemPrompt,
    "",
    "— You are being called as a specialist by the main Daemora agent.",
    "— Your last message MUST be a plain-text summary for the main agent: what you did, what worked, what failed, what's left, and the deliverable (path/URL/exact text). Never end on a tool call. Never reply empty.",
    "— You DO NOT have access to delegate further. Complete the task with the tools you have.",
    "— If you lack a tool required for the task, say so explicitly and return what partial result you can.",
  ];
  if (skillsIndex) {
    lines.push("", skillsIndex);
  }
  return lines.join("\n");
}

/**
 * Format the delegation contract into the user message the crew sees.
 *
 * If only `task` is present (internal callers like webhooks/watchers/
 * teams), pass it through verbatim so we don't bloat their existing
 * prose with empty tags. When the rich fields are present, wrap each
 * one in a tag so the crew can parse the contract structurally.
 */
function formatDelegationMessage(input: CrewRunInput): string {
  const hasRich =
    Boolean(input.context) ||
    Boolean(input.constraints) ||
    Boolean(input.successCriteria) ||
    (input.references?.length ?? 0) > 0;

  if (!hasRich) return input.task;

  const parts: string[] = [];
  parts.push(`<task>\n${input.task.trim()}\n</task>`);
  if (input.context && input.context.trim()) {
    parts.push(`<context>\n${input.context.trim()}\n</context>`);
  }
  if (input.constraints && input.constraints.trim()) {
    parts.push(`<constraints>\n${input.constraints.trim()}\n</constraints>`);
  }
  if (input.successCriteria && input.successCriteria.trim()) {
    parts.push(`<success-criteria>\n${input.successCriteria.trim()}\n</success-criteria>`);
  }
  if (input.references && input.references.length > 0) {
    const lines = input.references.map((r) => {
      const tail = r.why ? ` — ${r.why}` : "";
      return `- [${r.kind}] ${r.value}${tail}`;
    });
    parts.push(`<references>\n${lines.join("\n")}\n</references>`);
  }
  return parts.join("\n\n");
}

function previewArgs(part: { args?: unknown; input?: unknown }): string {
  const a = part.args ?? part.input;
  if (a === undefined || a === null) return "";
  try {
    const s = JSON.stringify(a);
    return s.length > 240 ? `${s.slice(0, 240)}…` : s;
  } catch {
    return "<unserializable>";
  }
}

function previewResult(part: { result?: unknown; output?: unknown }): string {
  const r = part.result ?? part.output;
  if (r === undefined || r === null) return "";
  try {
    const s = typeof r === "string" ? r : JSON.stringify(r);
    return s.length > 240 ? `${s.slice(0, 240)}…` : s;
  } catch {
    return "<unserializable>";
  }
}
