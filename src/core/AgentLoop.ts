/**
 * AgentLoop — runs one agent turn end to end. Owns:
 *   - The per-request ToolRegistry (core tools at construction; crew
 *     tools via installCrews() once the crew runner exists).
 *   - Calling the model with streaming + tool execution.
 *   - Surfacing every event (text, tool call, tool result, error) as a
 *     typed discriminated union the caller can translate to SSE / a UI.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { stepCountIs, streamText, type ModelMessage } from "ai";

import type { ConfigManager } from "../config/ConfigManager.js";
import type { CrewAgentRunner } from "../crew/CrewAgentRunner.js";
import type { CrewRegistry } from "../crew/CrewRegistry.js";
import type { EventBus } from "../events/eventBus.js";
import type { HookRunner } from "../hooks/HookRunner.js";
import type { LoopDetector } from "./LoopDetector.js";
import type { MCPManager } from "../mcp/MCPManager.js";
import type { DeclarativeMemoryStore } from "../memory/DeclarativeMemoryStore.js";
import type { MemoryStore } from "../memory/MemoryStore.js";
import type { SessionStore } from "../memory/SessionStore.js";
import type { ModelRouter } from "../models/ModelRouter.js";
import type { FilesystemGuard } from "../safety/FilesystemGuard.js";
import type { SkillLoader } from "../skills/SkillLoader.js";
import type { SkillRegistry } from "../skills/SkillRegistry.js";
import { buildCoreTools } from "../tools/core/index.js";
import { makeParallelCrewTool } from "../tools/core/parallelCrew.js";
import { makeListCrewsTool } from "../tools/core/listCrews.js";
import { makeUseCrewTool } from "../tools/core/useCrew.js";
import { ToolRegistry } from "../tools/registry.js";
import { toAiTool, type ToolContext, type ToolDef } from "../tools/types.js";
import { CancelledError, ConfigError, toDaemoraError } from "../util/errors.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("agent.loop");

/** Max tool-call iterations per turn. Prevents runaway loops. */
const DEFAULT_MAX_STEPS = 10;

/** Tool result payload cap (bytes) over SSE — DB keeps the full thing. */
const SSE_RESULT_CAP = 4_096;

export interface AgentLoopDeps {
  readonly cfg: ConfigManager;
  readonly models: ModelRouter;
  readonly skills: SkillRegistry;
  readonly guard: FilesystemGuard;
  readonly memory: MemoryStore;
  readonly mcp?: MCPManager;
  /** Optional user hooks (pre/post tool-call, task start/end). */
  readonly hooks?: HookRunner;
  /** Required to enable skill_manage — the agent writing new skills. */
  readonly skillLoader?: SkillLoader;
  /** Absolute path to the skills root directory. */
  readonly skillsRoot?: string;
  /** Declarative memory (MEMORY.md + USER.md). Injected into the system prompt. */
  readonly declarativeMemory?: DeclarativeMemoryStore;
  /** Session store — enables session_search tool. */
  readonly sessions?: SessionStore;
  /** Event bus for audit events. */
  readonly bus?: EventBus;
  /** Loop detector — intercepts repetitive tool calls before execution. */
  readonly loopDetector?: LoopDetector;
  /**
   * Returns the set of integration ids (twitter, youtube, facebook,
   * instagram) that currently have at least one connected account.
   * Tools with `source.kind === "integration"` are hidden from the
   * model unless their id is in this set — which means integration
   * crews stay invisible until the user connects the service.
   */
  readonly getEnabledIntegrations?: () => Set<string>;
}

export type AgentEvent =
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  | { type: "tool-result"; id: string; name: string; result: unknown; truncated: boolean }
  | { type: "tool-error"; id: string; name: string; message: string }
  | { type: "step-finish"; finishReason: string }
  | { type: "finish"; inputTokens: number; outputTokens: number }
  | { type: "error"; message: string };

export interface AgentTurnInput {
  readonly taskId: string;
  /** Session id — enables per-session system-prompt caching. */
  readonly sessionId?: string;
  readonly userMessage: string;
  /**
   * Image parts to merge into the user turn alongside text. Populated
   * when the user attached screenshots / photos (from a channel or the
   * UI composer). Dropped automatically for non-multimodal models in
   * the provider layer.
   */
  readonly userImages?: ReadonlyArray<{ readonly image: Buffer; readonly mimeType: string }>;
  /**
   * File parts (PDFs and any other provider-supported docs) to merge
   * into the user turn. The AI SDK maps `file` parts to each provider's
   * native document input — Anthropic `document`, Gemini `inline_data`,
   * OpenAI Responses file input — so the model reads the PDF with its
   * text, tables, and figures intact. No local extraction.
   */
  readonly userFiles?: ReadonlyArray<{ readonly data: Buffer; readonly mimeType: string; readonly filename?: string }>;
  readonly history?: readonly ModelMessage[];
  readonly model?: string;
  readonly maxSteps?: number;
  readonly abortSignal?: AbortSignal;
  /**
   * When true, the system prompt gains a short "voice mode" section
   * telling the model to reply in spoken, markdown-free style — no
   * tables, no code fences, no bullet walls. TTS would read those
   * literally ("pipe, pipe, newline, pipe...").
   */
  readonly voiceMode?: boolean;
  /**
   * Narrow the tools visible to the model for this turn only. Names
   * not in the allow-list are dropped before skill-matching or tool
   * selection run. Used by SubAgentManager to enforce per-spawn tool
   * permissions without mutating the shared registry.
   */
  readonly allowedTools?: readonly string[];
}

export interface AgentTurnResult {
  readonly modelId: string;
  readonly eventStream: AsyncIterable<AgentEvent>;
  readonly responseMessages: () => Promise<readonly ModelMessage[]>;
}

export class AgentLoop {
  readonly tools: ToolRegistry;
  readonly models: ModelRouter;

  private readonly cfg: ConfigManager;
  private readonly skills: SkillRegistry;
  private readonly mcp: MCPManager | undefined;
  private readonly hooks: HookRunner | undefined;
  private readonly declarativeMemory: DeclarativeMemoryStore | undefined;
  private readonly loopDetector: LoopDetector | undefined;
  private crews: CrewRegistry | undefined;

  /** Set at the start of every run() before tools can fire. */
  private _currentResolvedModelId = "";

  /**
   * Per-session system-prompt cache. Hermes pattern: build once at
   * session start, reuse across every turn. Invalidated by
   * `invalidateSystemPromptCache(sessionId)` on compaction, memory
   * reload, or skill-set change.
   */
  private readonly systemPromptCache = new Map<string, string>();
  private readonly getEnabledIntegrations?: () => Set<string>;

  constructor(deps: AgentLoopDeps) {
    this.cfg = deps.cfg;
    this.models = deps.models;
    this.skills = deps.skills;
    this.mcp = deps.mcp;
    this.hooks = deps.hooks;
    this.declarativeMemory = deps.declarativeMemory;
    this.loopDetector = deps.loopDetector;
    if (deps.getEnabledIntegrations) this.getEnabledIntegrations = deps.getEnabledIntegrations;

    this.tools = new ToolRegistry();
    const skills = deps.skills;
    const skillLoader = deps.skillLoader;
    const skillsRoot = deps.skillsRoot;
    this.tools.registerAll(buildCoreTools({
      cfg: deps.cfg, guard: deps.guard, memory: deps.memory,
      skills, models: deps.models,
      ...(deps.mcp ? { mcp: deps.mcp } : {}),
      ...(skillLoader ? { skillLoader } : {}),
      ...(skillsRoot ? { skillsRoot } : {}),
      ...(deps.declarativeMemory ? { declarativeMemory: deps.declarativeMemory } : {}),
      ...(deps.sessions ? { sessions: deps.sessions } : {}),
      ...(deps.bus ? { bus: deps.bus } : {}),
      ...(skillLoader && skillsRoot
        ? {
            onSkillsChanged: async () => {
              const { loaded } = await skillLoader.loadAll();
              skills.replace(loaded);
              // Skills changed → every session's cached system prompt
              // is stale; drop them all so the next turn rebuilds.
              this.systemPromptCache.clear();
            },
          }
        : {}),
    }));
  }

  /**
   * Install crew delegation tools AFTER the CrewAgentRunner exists.
   * Split from the constructor because the runner needs a reference
   * back to THIS AgentLoop's ToolRegistry, closing the init cycle.
   */
  installCrews(registry: CrewRegistry, runner: CrewAgentRunner): void {
    this.crews = registry;
    // list_crews is registered even when there are zero crews loaded —
    // it just returns an empty list. Doing it unconditionally keeps the
    // tool catalog stable so the model can probe the registry safely.
    this.tools.register(makeListCrewsTool(registry) as unknown as ToolDef);
    if (registry.size === 0) return;
    const turn = { resolvedModel: () => this.currentResolvedModel() };
    this.tools.register(makeUseCrewTool(registry, runner, turn) as unknown as ToolDef);
    this.tools.register(makeParallelCrewTool(registry, runner, turn) as unknown as ToolDef);
  }

  /** Model id the live turn is resolved to. Throws if called outside a turn. */
  currentResolvedModel(): string {
    if (!this._currentResolvedModelId) {
      throw new ConfigError("currentResolvedModel() called outside a turn");
    }
    return this._currentResolvedModelId;
  }

  /**
   * Invalidate cached system prompt for a session. Call when:
   *   - Compaction rolled the session to a child id (the child gets a
   *     fresh system prompt matching the compacted head).
   *   - Declarative memory was reloaded.
   *   - Skill registry was mutated.
   */
  invalidateSystemPromptCache(sessionId?: string): void {
    if (!sessionId) { this.systemPromptCache.clear(); return; }
    for (const key of this.systemPromptCache.keys()) {
      if (key.startsWith(`${sessionId}:`)) this.systemPromptCache.delete(key);
    }
  }

  async run(input: AgentTurnInput): Promise<AgentTurnResult> {
    const modelId = input.model ?? this.models.resolveDefault();
    const resolved = await this.models.resolve(modelId);
    this._currentResolvedModelId = resolved.id;

    const enabledIntegrations = this.getEnabledIntegrations?.() ?? new Set<string>();
    // Pure hermes pattern: no matcher. Every available tool goes into
    // the turn; the agent decides via the skill index which skills to
    // load, and calls skill_view(name) to read them.
    const availableNames = input.allowedTools && input.allowedTools.length > 0
      ? new Set(input.allowedTools)
      : new Set(this.tools.list().map((t) => t.name));

    const allToolDefs = this.tools.available(enabledIntegrations);
    const toolDefs = input.allowedTools && input.allowedTools.length > 0
      ? allToolDefs.filter((t) => availableNames.has(t.name))
      : allToolDefs;

    // System prompt: cached per-session when sessionId is provided (hermes
    // pattern). Voice mode flips the prompt content so it gets its own
    // cache key; sub-agent spawns with allowedTools bypass the cache since
    // the skills index reflects the narrower toolset.
    const cacheKey = input.sessionId && !input.voiceMode
      && !(input.allowedTools && input.allowedTools.length > 0)
      ? `${input.sessionId}:${resolved.id}` : null;
    let systemPrompt: string;
    if (cacheKey && this.systemPromptCache.has(cacheKey)) {
      systemPrompt = this.systemPromptCache.get(cacheKey)!;
    } else {
      const skillsIndex = this.skills.renderIndexForPrompt({
        availableTools: availableNames,
        enabledIntegrations,
      });
      systemPrompt = await this.buildSystemPrompt(skillsIndex, input.voiceMode ?? false);
      if (cacheKey) this.systemPromptCache.set(cacheKey, systemPrompt);
    }
    // Build the user turn. When images are attached we switch to the
    // multimodal content-parts form: [{type:'text'}, {type:'image'}, …].
    // The AI SDK transparently drops image parts for non-multimodal
    // models, so this is safe even if the resolved model is text-only.
    const hasImages = !!(input.userImages && input.userImages.length > 0);
    const hasFiles = !!(input.userFiles && input.userFiles.length > 0);
    const userContent = hasImages || hasFiles
      ? [
          { type: "text" as const, text: input.userMessage },
          ...(input.userImages ?? []).map((p) => ({
            type: "image" as const,
            image: p.image,
            mediaType: p.mimeType,
          })),
          ...(input.userFiles ?? []).map((p) => ({
            type: "file" as const,
            data: p.data,
            mediaType: p.mimeType,
            ...(p.filename ? { filename: p.filename } : {}),
          })),
        ]
      : input.userMessage;
    const messages: ModelMessage[] = [
      ...(input.history ?? []),
      { role: "user", content: userContent } as ModelMessage,
    ];

    const ctxFactory = (signal: AbortSignal): ToolContext => ({
      abortSignal: signal,
      taskId: input.taskId,
      logger: {
        info: (msg, ctx) => log.info({ taskId: input.taskId, ...ctx }, msg),
        warn: (msg, ctx) => log.warn({ taskId: input.taskId, ...ctx }, msg),
        error: (msg, ctx) => log.error({ taskId: input.taskId, ...ctx }, msg),
      },
    });
    const hooks = this.hooks;
    const loops = this.loopDetector;
    const aiTools = Object.fromEntries(
      toolDefs.map((t) => {
        let def: ToolDef = t;
        if (loops) def = wrapWithLoopDetection(def, loops, input.taskId);
        if (hooks) def = wrapWithHooks(def, hooks, input.taskId);
        return [t.name, toAiTool(def, ctxFactory)];
      }),
    );

    log.info(
      {
        taskId: input.taskId,
        modelId,
        toolCount: toolDefs.length,
        skillsVisible: this.skills.visible({
          availableTools: availableNames,
          enabledIntegrations,
        }).length,
        maxSteps: input.maxSteps ?? DEFAULT_MAX_STEPS,
        crewCount: this.crews?.size ?? 0,
      },
      "agent turn starting",
    );

    const stream = streamText({
      model: resolved.model,
      system: systemPrompt,
      messages,
      tools: aiTools,
      stopWhen: stepCountIs(input.maxSteps ?? DEFAULT_MAX_STEPS),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });

    const events = translateFullStream(stream.fullStream, input);

    return {
      modelId: resolved.id,
      eventStream: events,
      responseMessages: async () => {
        const resp = await stream.response;
        return resp.messages as readonly ModelMessage[];
      },
    };
  }

  private async buildSystemPrompt(
    skillsIndex: string,
    voiceMode: boolean,
  ): Promise<string> {
    // SOUL.md is the agent's core personality — loaded once and cached.
    if (!AgentLoop._soulPrompt) {
      try {
        const soulPath = join(dirname(fileURLToPath(import.meta.url)), "../../SOUL.md");
        AgentLoop._soulPrompt = readFileSync(soulPath, "utf-8").trim();
      } catch {
        AgentLoop._soulPrompt = "You are Daemora — a personal AI agent. Call tools to complete tasks. Be direct.";
      }
    }

    const sections: string[] = [AgentLoop._soulPrompt];

    // Plan Mode — when on, the agent must ask before every destructive
    // action via reply_to_user and wait for explicit approval. Injected
    // here so the prefix cache picks it up per turn (the setting can
    // change at runtime).
    const planMode = this.cfg.settings.getGeneric("PLAN_MODE");
    if (planMode === true || planMode === "true" || planMode === 1) {
      sections.push([
        "",
        "## ⚠️ Plan Mode is ON",
        "Before EVERY destructive or side-effectful action — `write_file`, `edit_file`, `apply_patch`, `execute_command`, `send_email`, `send_file`, `broadcast`, `message_channel`, `cron`, `manage_*`, browser non-read actions (navigate / click / fill / type / submit), `generate_video`, `generate_music`, `generate_image`, deleting anything — you MUST first call `reply_to_user` describing exactly what you're about to do and ask for approval. Then STOP and wait for the user's next message.",
        "Only proceed if the user replies with an affirmative (yes / go / approve / proceed / sure / ok / do it). If they reply with stop / no / cancel / deny, abort that action and ask what to do instead.",
        "Read-only ops are exempt: `read_file`, `list_directory`, `glob`, `grep`, `web_search`, `web_fetch`, `snapshot`, `getText`, `getCookies`, etc.",
        "Voice mode: still ask, but in spoken form — \"Want me to do X?\" and wait for \"yeah\"/\"go\". Don't enumerate paths or IDs aloud.",
      ].join("\n"));
    }

    // Declarative memory — frozen snapshots injected once per session
    // so the prefix cache stays warm across every turn.
    if (this.declarativeMemory) {
      const userBlock = this.declarativeMemory.formatForSystemPrompt("user");
      if (userBlock) sections.push("\n" + userBlock);
      const memBlock = this.declarativeMemory.formatForSystemPrompt("memory");
      if (memBlock) sections.push("\n" + memBlock);
    }

    // Available tools summary so the agent knows what it can call.
    const toolNames = this.tools.list().map((t) => t.name);
    sections.push(`\n## Available Tools\n${toolNames.join(", ")}`);

    if (this.crews && this.crews.size > 0) {
      sections.push("\n## Available Crews");
      for (const line of this.crews.summaryLines()) sections.push(line);
    }

    if (this.mcp) {
      const all = this.mcp.listStatus();
      // Browser MCP is gated to the browser-pilot crew. Hide it from the
      // main agent's surface so the model picks the crew route instead of
      // calling use_mcp("playwright", ...) directly. Discipline lives in
      // the crew's prompt, not bolted onto the main agent.
      const HIDE_FROM_MAIN: ReadonlySet<string> = new Set(["playwright"]);
      const connected = all.filter((s) => s.status === "connected" && !HIDE_FROM_MAIN.has(s.name));
      const inactive = all.filter((s) => s.status !== "connected" && !HIDE_FROM_MAIN.has(s.name));
      const playwrightConnected = all.some((s) => s.name === "playwright" && s.status === "connected");

      if (connected.length > 0) {
        sections.push("\n## Connected MCP Servers");
        for (const s of connected) {
          sections.push(`- ${s.name}: ${s.tools.length} tools (${s.tools.map((t) => t.name).join(", ")})`);
        }
        sections.push("Call `use_mcp(server, task)` to delegate, or `use_mcp(server, task, tool, args)` to call a specific tool.");
      }

      if (playwrightConnected) {
        sections.push(
          "\n## Browser automation routing",
          "For ANY browser/web work — logins, posting on social sites, scraping, form fill, downloads, uploads — call `use_crew(\"browser-pilot\", \"<task>\")`. Do NOT call `use_mcp(\"playwright\", ...)` directly. The crew runs with the right prompt, the right discipline, and a smaller tool surface; you'll get more reliable results and cheaper tokens.",
        );
      }

      // Make the distinction explicit: the agent should NOT claim these
      // are currently usable. They exist as configurable integrations
      // the USER can enable from the /mcp page. If the agent calls
      // `use_mcp` on one of these it gets a "server is disabled" error.
      if (inactive.length > 0) {
        sections.push("\n## Inactive MCP Servers (USER must enable before use)");
        sections.push(
          "These are registered but not currently connected. " +
          "You CANNOT call tools on them. " +
          "If the user asks for one, tell them to enable it at `/mcp` and configure any required credentials.",
        );
        sections.push(inactive.map((s) => `- ${s.name}${s.configured ? "" : " (needs config)"}`).join("\n"));
      }
    }

    if (skillsIndex) {
      sections.push("\n" + skillsIndex);
    }

    if (voiceMode) {
      sections.push(
        "\n## VOICE MODE ENABLED",
        "Read aloud. Talk like a human — be short/concise 1 or 1.5 sentences, warm, with emotion.",
        "- Summarise. Never list, enumerate, or recite identifiers, codes, paths, or technical details.",
        "- No markdown, bullets, code, emoji, URLs, No numbers read digit-by-digit.",
        "- Output plain spoken words only. No punctuation/symbols like / * ^ % @ ! # ( ) ~ _ | < > { } [ ] \\ ` — use only .,?! as sentence punctuation.",
      );
    }

    void this.cfg;
    return sections.join("\n");
  }

  private static _soulPrompt: string | null = null;
}

async function* translateFullStream(
  fullStream: AsyncIterable<unknown>,
  input: AgentTurnInput,
): AsyncIterable<AgentEvent> {
  try {
    for await (const raw of fullStream) {
      const part = raw as { type: string } & Record<string, unknown>;
      switch (part.type) {
        case "text-delta": {
          const text = (part["text"] as string) ?? "";
          if (text.length > 0) yield { type: "text-delta", delta: text };
          break;
        }
        case "reasoning-delta": {
          const text = (part["text"] as string) ?? "";
          if (text.length > 0) yield { type: "reasoning-delta", delta: text };
          break;
        }
        case "tool-call": {
          const id = String(part["toolCallId"] ?? "");
          const name = String(part["toolName"] ?? "");
          const args = part["input"] ?? part["args"] ?? null;
          log.info({ taskId: input.taskId, toolCallId: id, tool: name, args }, "tool call");
          yield { type: "tool-call", id, name, args };
          break;
        }
        case "tool-result": {
          const result = part["output"] ?? part["result"] ?? null;
          const { value, truncated } = clipForTransport(result);
          const id = String(part["toolCallId"] ?? "");
          const name = String(part["toolName"] ?? "");
          log.info({ taskId: input.taskId, toolCallId: id, tool: name, truncated }, "tool result");
          yield { type: "tool-result", id, name, result: value, truncated };
          break;
        }
        case "tool-error": {
          const err = part["error"] as { message?: string } | undefined;
          const message = err?.message ?? String(part["error"] ?? "tool error");
          const id = String(part["toolCallId"] ?? "");
          const name = String(part["toolName"] ?? "");
          log.error({ taskId: input.taskId, toolCallId: id, tool: name, err: message }, "tool error");
          yield { type: "tool-error", id, name, message };
          break;
        }
        case "finish-step": {
          yield { type: "step-finish", finishReason: String(part["finishReason"] ?? "unknown") };
          break;
        }
        case "finish": {
          const usage = (part["totalUsage"] ?? part["usage"] ?? {}) as {
            inputTokens?: number;
            outputTokens?: number;
          };
          yield {
            type: "finish",
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
          };
          break;
        }
        case "error": {
          const err = part["error"];
          const msg = err instanceof Error ? err.message : String(err ?? "stream error");
          yield { type: "error", message: msg };
          break;
        }
      }
    }
  } catch (e) {
    if (input.abortSignal?.aborted) throw new CancelledError();
    const err = toDaemoraError(e);
    log.error({ taskId: input.taskId, err: err.message, code: err.code }, "agent stream error");
    yield { type: "error", message: err.message };
  }
}

function clipForTransport(value: unknown): { value: unknown; truncated: boolean } {
  const json = safeStringify(value);
  if (json.length <= SSE_RESULT_CAP) return { value, truncated: false };
  return {
    value: `${json.slice(0, SSE_RESULT_CAP)}…[+${json.length - SSE_RESULT_CAP} more bytes]`,
    truncated: true,
  };
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v) ?? ""; } catch { return String(v); }
}

/**
 * Decorate a tool with loop-detection. Before execute() fires, record
 * the call in the detector's per-task history. If a loop is detected,
 * throw — streamText surfaces as tool-error, model reacts.
 */
function wrapWithLoopDetection(def: ToolDef, loops: LoopDetector, taskId: string): ToolDef {
  return {
    ...def,
    execute: async (input: unknown, ctx: ToolContext) => {
      const check = loops.record(def.name, input, taskId);
      if (check.blocked) {
        throw new Error(check.message ?? `Loop detected in tool "${def.name}"`);
      }
      const parsed = def.inputSchema.parse(input);
      return def.execute(parsed, ctx);
    },
  };
}

/**
 * Decorate a tool with PreToolUse / PostToolUse hooks. A blocking
 * pre-hook throws — streamText surfaces that as a tool-error and the
 * model gets a chance to react ("tool blocked: reason"). Modified
 * input silently replaces the original. Post-hooks are fire-and-forget:
 * their decision is logged but cannot unmake the side effect.
 */
function wrapWithHooks(def: ToolDef, hooks: HookRunner, taskId: string): ToolDef {
  return {
    ...def,
    execute: async (input: unknown, ctx: ToolContext) => {
      const pre = await hooks.run("PreToolUse", { taskId, toolName: def.name, toolInput: input });
      if (pre.decision === "block") {
        const reason = pre.reason ?? "blocked by hook";
        throw new Error(`tool ${def.name} blocked by hook: ${reason}`);
      }
      const effectiveInput = pre.modifiedInput ?? input;
      const parsed = def.inputSchema.parse(effectiveInput);
      const result = await def.execute(parsed, ctx);
      await hooks.run("PostToolUse", { taskId, toolName: def.name, toolInput: parsed, toolOutput: result });
      return result;
    },
  };
}
