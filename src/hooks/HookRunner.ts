/**
 * HookRunner — event-driven interception at tool-call lifecycle points.
 *
 * Users register hooks in `{dataDir}/hooks.json` that fire on:
 *   - PreToolUse   before a tool executes; can block or modify input
 *   - PostToolUse  after a tool executes; observational (logging, alerts)
 *   - TaskStart    when a turn begins (AgentLoop.run)
 *   - TaskEnd      when a turn terminates (success or failure)
 *
 * Hook kinds:
 *   - "command"  run a shell command with TOOL_NAME / TOOL_INPUT / TASK_ID /
 *                EVENT env vars; stdout is parsed as JSON for the decision.
 *                Only this kind is supported — inline JS eval is a security
 *                hole and crews provide the same flexibility safely.
 *
 * Hook output schema (stdout of the command):
 *   { "decision": "allow" | "block" | "ask",
 *     "reason":   string,
 *     "modifiedInput": object }
 *
 * Non-JSON stdout → treated as allow (the command succeeded, no opinion).
 * Non-zero exit → fail-open (allow). The logs surface the failure so the
 * user can debug; we never let a broken hook wedge tool execution.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { createLogger } from "../util/logger.js";

const log = createLogger("hooks");

export type HookEvent = "PreToolUse" | "PostToolUse" | "TaskStart" | "TaskEnd";

const HOOK_EVENTS: readonly HookEvent[] = ["PreToolUse", "PostToolUse", "TaskStart", "TaskEnd"];

const hookSchema = z.object({
  kind: z.literal("command"),
  /** `*` matches all tools; otherwise matched against the tool name. */
  matcher: z.string().optional(),
  command: z.string(),
  /** Milliseconds before we kill the hook. */
  timeoutMs: z.number().int().positive().max(30_000).default(5_000),
});

const hooksFileSchema = z.object({
  PreToolUse: z.array(hookSchema).optional(),
  PostToolUse: z.array(hookSchema).optional(),
  TaskStart: z.array(hookSchema).optional(),
  TaskEnd: z.array(hookSchema).optional(),
}).strict();

export type HookDef = z.infer<typeof hookSchema>;
type HooksFile = z.infer<typeof hooksFileSchema>;

export interface HookContext {
  readonly event: HookEvent;
  readonly taskId: string;
  readonly toolName?: string;
  readonly toolInput?: unknown;
  readonly toolOutput?: unknown;
}

export interface HookResult {
  readonly decision: "allow" | "block" | "ask";
  readonly reason?: string;
  readonly modifiedInput?: Record<string, unknown>;
}

export class HookRunner {
  private hooks: HooksFile = {};
  private loaded = false;
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "hooks.json");
  }

  load(): void {
    if (!existsSync(this.filePath)) {
      this.hooks = {};
      this.loaded = true;
      return;
    }
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = hooksFileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        log.warn({ errors: parsed.error.issues }, "hooks.json failed validation — hooks disabled");
        this.hooks = {};
      } else {
        this.hooks = parsed.data;
        const total = HOOK_EVENTS.reduce((n, ev) => n + (this.hooks[ev]?.length ?? 0), 0);
        log.info({ file: this.filePath, count: total }, "hooks loaded");
      }
    } catch (e) {
      log.error({ err: (e as Error).message }, "hooks.json parse failed — hooks disabled");
      this.hooks = {};
    }
    this.loaded = true;
  }

  /** Watch the file for changes and hot-reload. Idempotent. */
  watch(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const w = watch(this.filePath, { persistent: false }, () => {
        log.info("hooks.json changed — reloading");
        this.load();
      });
      w.unref();
    } catch {
      // Some FSes don't support watch — silently degrade.
    }
  }

  stats(): Record<HookEvent, number> {
    if (!this.loaded) this.load();
    return {
      PreToolUse: this.hooks.PreToolUse?.length ?? 0,
      PostToolUse: this.hooks.PostToolUse?.length ?? 0,
      TaskStart: this.hooks.TaskStart?.length ?? 0,
      TaskEnd: this.hooks.TaskEnd?.length ?? 0,
    };
  }

  /**
   * Run every hook registered for `event` that matches the context's
   * `toolName`. Returns the merged decision:
   *
   *   - first `block` short-circuits — that's the returned result
   *   - first `ask` survives unless a later hook blocks
   *   - any `modifiedInput` on the first allowing hook propagates
   *   - otherwise the result is `allow`
   */
  async run(event: HookEvent, ctx: Omit<HookContext, "event">): Promise<HookResult> {
    if (!this.loaded) this.load();
    const list = this.hooks[event];
    if (!list || list.length === 0) return { decision: "allow" };

    const matching = list.filter((h) => !h.matcher || h.matcher === "*" || h.matcher === ctx.toolName);
    if (matching.length === 0) return { decision: "allow" };

    let askResult: HookResult | undefined;
    let modifiedInput: Record<string, unknown> | undefined;

    for (const hook of matching) {
      try {
        const result = await this.executeHook(hook, { ...ctx, event });
        if (result.decision === "block") {
          log.warn({ event, tool: ctx.toolName, reason: result.reason }, "hook blocked tool");
          return result;
        }
        if (result.decision === "ask" && !askResult) askResult = result;
        if (result.modifiedInput && !modifiedInput) modifiedInput = result.modifiedInput;
      } catch (e) {
        log.error({ event, tool: ctx.toolName, err: (e as Error).message }, "hook crashed — failing open");
        // fall through — treat as allow
      }
    }

    if (askResult) return askResult;
    if (modifiedInput) return { decision: "allow", modifiedInput };
    return { decision: "allow" };
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private executeHook(hook: HookDef, ctx: HookContext): Promise<HookResult> {
    return new Promise((resolve) => {
      const child = spawn(hook.command, {
        shell: true,
        env: {
          ...process.env,
          TOOL_NAME: ctx.toolName ?? "",
          TOOL_INPUT: safeJson(ctx.toolInput),
          TOOL_OUTPUT: safeJson(ctx.toolOutput),
          TASK_ID: ctx.taskId,
          EVENT: ctx.event,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdout: string[] = [];
      const stderr: string[] = [];
      child.stdout.on("data", (d) => stdout.push(d.toString("utf-8")));
      child.stderr.on("data", (d) => stderr.push(d.toString("utf-8")));

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        log.warn({ command: hook.command, timeoutMs: hook.timeoutMs }, "hook timed out");
      }, hook.timeoutMs).unref();

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          log.warn({ command: hook.command, code, stderr: stderr.join("").slice(0, 200) }, "hook exit non-zero");
          resolve({ decision: "allow" });
          return;
        }
        resolve(parseHookOutput(stdout.join("")));
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        log.warn({ command: hook.command, err: err.message }, "hook spawn failed");
        resolve({ decision: "allow" });
      });
    });
  }
}

function safeJson(v: unknown): string {
  if (v === undefined || v === null) return "";
  try { return JSON.stringify(v); } catch { return ""; }
}

function parseHookOutput(raw: string): HookResult {
  const text = raw.trim();
  if (!text) return { decision: "allow" };
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const decision = parsed["decision"];
    if (decision === "block" || decision === "ask" || decision === "allow") {
      const result: HookResult = { decision };
      if (typeof parsed["reason"] === "string") (result as { reason?: string }).reason = parsed["reason"];
      if (parsed["modifiedInput"] && typeof parsed["modifiedInput"] === "object") {
        (result as { modifiedInput?: Record<string, unknown> }).modifiedInput = parsed["modifiedInput"] as Record<string, unknown>;
      }
      return result;
    }
  } catch {
    // Non-JSON output = implicit allow with the text as reason.
  }
  return { decision: "allow" };
}
