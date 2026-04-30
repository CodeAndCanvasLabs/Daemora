/**
 * Supervisor — watches the EventBus for runaway agent behaviour and
 * enforces kill / warn thresholds.
 *
 * Listens to task:tool:before events and tracks:
 *   • tool calls per minute (rate-limit with warn + hard-kill tiers)
 *   • tool calls per task total (budget with warn + hard-kill tiers)
 *   • dangerous command patterns (rm -rf /, sudo in executeCommand)
 *
 * When a hard limit is crossed it calls TaskRunner.cancel() — the same
 * path the /api/tasks/:id/cancel endpoint uses — so the AgentLoop and
 * any in-flight tool aborts cleanly.
 *
 * Warnings are kept in an in-memory ring and re-emitted as
 * "supervisor:warning" / "supervisor:alert" events so the UI / audit
 * log can surface them.
 */

import { EventEmitter } from "node:events";

import type { EventBus } from "../events/eventBus.js";
import type { TaskRunner } from "../core/TaskRunner.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("supervisor");

export interface SupervisorOpts {
  /** Soft limit: log a warning when exceeded. Default 30. */
  readonly maxToolCallsPerMinute?: number;
  /** Hard limit multiplier on the per-minute limit — triggers kill. Default 2. */
  readonly perMinuteHardMultiplier?: number;
  /** Soft limit per task. Default 100. */
  readonly maxToolCallsPerTask?: number;
  /** Hard limit multiplier on the per-task limit — triggers kill. Default 1.5. */
  readonly perTaskHardMultiplier?: number;
  /** How many recent warnings to retain. Default 100. */
  readonly warningRingSize?: number;
}

export interface SupervisorWarning {
  readonly level: "warning" | "alert";
  readonly taskId: string;
  readonly message: string;
  readonly at: number;
}

export class Supervisor extends EventEmitter {
  private readonly maxPerMinute: number;
  private readonly perMinuteHardMul: number;
  private readonly maxPerTask: number;
  private readonly perTaskHardMul: number;
  private readonly ringSize: number;

  private readonly toolCallCounts = new Map<string, number>();
  private readonly toolCallTimestamps = new Map<string, number[]>();
  private readonly warnings: SupervisorWarning[] = [];
  private readonly killed = new Set<string>();

  private unsubBefore: (() => void) | null = null;
  private unsubAfter: (() => void) | null = null;
  private unsubState: (() => void) | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly runner: TaskRunner,
    opts: SupervisorOpts = {},
  ) {
    super();
    this.maxPerMinute = opts.maxToolCallsPerMinute ?? 30;
    this.perMinuteHardMul = opts.perMinuteHardMultiplier ?? 2;
    this.maxPerTask = opts.maxToolCallsPerTask ?? 100;
    this.perTaskHardMul = opts.perTaskHardMultiplier ?? 1.5;
    this.ringSize = opts.warningRingSize ?? 100;
  }

  start(): void {
    if (this.unsubBefore) return;
    this.unsubBefore = this.bus.on("task:tool:before", (ev) => this.onToolBefore(ev));
    this.unsubAfter = this.bus.on("task:tool:after", (ev) => this.onToolAfter(ev));
    this.unsubState = this.bus.on("task:state", (ev) => {
      if (ev.status !== "running") this.cleanupTask(ev.taskId);
    });
    log.info(
      {
        maxPerMinute: this.maxPerMinute,
        maxPerTask: this.maxPerTask,
      },
      "supervisor started",
    );
  }

  stop(): void {
    this.unsubBefore?.(); this.unsubBefore = null;
    this.unsubAfter?.(); this.unsubAfter = null;
    this.unsubState?.(); this.unsubState = null;
    log.info("supervisor stopped");
  }

  /** Recently-observed warnings (most recent last). */
  getWarnings(limit = 50): readonly SupervisorWarning[] {
    return this.warnings.slice(-limit);
  }

  /** Whether this task has been killed by the supervisor. */
  isKilled(taskId: string): boolean {
    return this.killed.has(taskId);
  }

  // ── Hooks ───────────────────────────────────────────────────────

  private onToolBefore(ev: { taskId: string; name: string; args: unknown }): void {
    const { taskId, name, args } = ev;

    const count = (this.toolCallCounts.get(taskId) ?? 0) + 1;
    this.toolCallCounts.set(taskId, count);

    const now = Date.now();
    const stamps = this.toolCallTimestamps.get(taskId) ?? [];
    stamps.push(now);
    const cutoff = now - 60_000;
    const recent = stamps.filter((t) => t > cutoff);
    this.toolCallTimestamps.set(taskId, recent);

    // Per-minute budget
    const perMinuteHard = Math.floor(this.maxPerMinute * this.perMinuteHardMul);
    if (recent.length > perMinuteHard) {
      this.kill(taskId, `runaway: ${recent.length} tool calls / min (hard ${perMinuteHard})`);
      return;
    }
    if (recent.length > this.maxPerMinute) {
      this.warn(taskId, `rate-limit: ${recent.length} calls / min (soft ${this.maxPerMinute})`);
    }

    // Per-task budget
    const perTaskHard = Math.floor(this.maxPerTask * this.perTaskHardMul);
    if (count > perTaskHard) {
      this.kill(taskId, `runaway: ${count} total tool calls (hard ${perTaskHard})`);
      return;
    }
    if (count > this.maxPerTask) {
      this.warn(taskId, `budget: ${count} total calls (soft ${this.maxPerTask})`);
    }

    // Dangerous command heuristics on the shell tool.
    if (name === "execute_command" || name === "executeCommand") {
      const cmd = pickCommandString(args);
      if (cmd) {
        if (/rm\s+-rf\s+\//.test(cmd)) {
          this.alert(taskId, `BLOCKED: destructive command: ${cmd.slice(0, 80)}`);
          this.kill(taskId, "destructive command attempted");
        } else if (/\bsudo\b/.test(cmd)) {
          this.warn(taskId, `sudo command: ${cmd.slice(0, 80)}`);
        }
      }
    }
  }

  private onToolAfter(_ev: { taskId: string; name: string }): void {
    // Reserved for secret-scan / output-length checks — keep the hook
    // wired so the Supervisor owns the full tool lifecycle.
  }

  // ── Internals ───────────────────────────────────────────────────

  private kill(taskId: string, reason: string): void {
    if (this.killed.has(taskId)) return;
    this.killed.add(taskId);
    log.warn({ taskId, reason }, "supervisor kill");
    this.alert(taskId, `KILL: ${reason}`);
    this.runner.cancel(taskId, `supervisor: ${reason}`);
    this.emit("kill", { taskId, reason });
  }

  private warn(taskId: string, message: string): void {
    this.push({ level: "warning", taskId, message, at: Date.now() });
    this.emit("warning", { taskId, message });
  }

  private alert(taskId: string, message: string): void {
    this.push({ level: "alert", taskId, message, at: Date.now() });
    log.error({ taskId, message }, "supervisor alert");
    this.emit("alert", { taskId, message });
  }

  private push(w: SupervisorWarning): void {
    this.warnings.push(w);
    if (this.warnings.length > this.ringSize) {
      this.warnings.splice(0, this.warnings.length - this.ringSize);
    }
  }

  private cleanupTask(taskId: string): void {
    this.toolCallCounts.delete(taskId);
    this.toolCallTimestamps.delete(taskId);
    this.killed.delete(taskId);
  }
}

function pickCommandString(args: unknown): string | null {
  if (typeof args === "string") return args;
  if (args && typeof args === "object") {
    const obj = args as { command?: unknown };
    if (typeof obj.command === "string") return obj.command;
  }
  return null;
}
