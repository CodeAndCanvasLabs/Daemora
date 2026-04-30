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

/** Max tool-call iterations inside a crew. Bounded to keep spawns cheap. */
const DEFAULT_CREW_MAX_STEPS = 15;

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

export interface CrewRunInput {
  readonly crewId: string;
  readonly task: string;
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
    const userMsg: ModelMessage = { role: "user", content: input.task };
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
      },
      "crew run starting",
    );

    const stream = streamText({
      model: resolved.model,
      system: systemPrompt,
      messages: [...history, userMsg],
      tools: crewToolset,
      temperature: crew.manifest.profile.temperature,
      stopWhen: stepCountIs(input.maxSteps ?? DEFAULT_CREW_MAX_STEPS),
      abortSignal: input.abortSignal,
    });

    // Exhaust the stream. We don't forward deltas — the main agent gets
    // the final answer via the tool result only. Iteration still drives
    // streamText's internal tool-call loop.
    let toolCalls = 0;
    let steps = 0;
    let streamError: string | null = null;
    try {
      for await (const part of stream.fullStream as AsyncIterable<{ type: string }>) {
        if (part.type === "tool-call") toolCalls++;
        if (part.type === "finish-step") steps++;
        if (part.type === "error") {
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
    for (const msg of resp.messages) {
      const m = msg as ModelMessage;
      this.sessions.appendMessage(session.id, m, estimateMessageTokens(m));
    }

    const text = await stream.text;
    const usage = await stream.totalUsage;

    return {
      crewId: crew.manifest.id,
      sessionId: session.id,
      text,
      toolCalls,
      steps,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
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
    "— Do the requested work and return a concise, structured result.",
    "— You DO NOT have access to delegate further. Complete the task with the tools you have.",
    "— If you lack a tool required for the task, say so explicitly and return what partial result you can.",
  ];
  if (skillsIndex) {
    lines.push("", skillsIndex);
  }
  return lines.join("\n");
}
