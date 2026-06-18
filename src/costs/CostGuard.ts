/**
 * CostGuard — enforces per-task and per-day cost caps for the tenant
 * this daemora is running for.
 *
 *   beforeCall(taskId, estimateUsd?)   throw CostCapExceededError if capped
 *   currentDailyUsd()                  what we've spent today (UTC)
 *   currentTaskUsd(taskId)             what this task has cost so far
 *
 * Caps are read from env at boot:
 *   DAEMORA_MAX_DAILY_COST     USD/day, 0 = unlimited
 *   DAEMORA_MAX_COST_PER_TASK  USD/task, 0 = unlimited
 *
 * Multi-tenant cloud sets these per-tenant. Single-tenant local install
 * leaves them unset → no caps.
 */

import type { CostTracker } from "./CostTracker.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("costs.guard");

export class CostCapExceededError extends Error {
  constructor(
    readonly scope: "daily" | "task",
    readonly capUsd: number,
    readonly spentUsd: number,
  ) {
    super(
      scope === "daily"
        ? `Daily cost cap exceeded: $${spentUsd.toFixed(4)} >= $${capUsd.toFixed(2)} — resets midnight UTC`
        : `Per-task cost cap exceeded: $${spentUsd.toFixed(4)} >= $${capUsd.toFixed(2)} for this task`,
    );
    this.name = "CostCapExceededError";
  }
}

export interface CostGuardOpts {
  readonly maxDailyUsd: number;     // 0 = unlimited
  readonly maxPerTaskUsd: number;   // 0 = unlimited
  readonly tracker: CostTracker;
}

export class CostGuard {
  private readonly maxDailyUsd: number;
  private readonly maxPerTaskUsd: number;
  private readonly tracker: CostTracker;

  constructor(opts: CostGuardOpts) {
    this.maxDailyUsd = Math.max(0, opts.maxDailyUsd);
    this.maxPerTaskUsd = Math.max(0, opts.maxPerTaskUsd);
    this.tracker = opts.tracker;
    log.info(
      { dailyCapUsd: this.maxDailyUsd || "unlimited", taskCapUsd: this.maxPerTaskUsd || "unlimited" },
      "cost guard armed",
    );
  }

  /** Build a guard from process.env. Returns undefined if no caps set. */
  static fromEnv(tracker: CostTracker, env: NodeJS.ProcessEnv = process.env): CostGuard | undefined {
    const daily = parseDollar(env["DAEMORA_MAX_DAILY_COST"]);
    const task = parseDollar(env["DAEMORA_MAX_COST_PER_TASK"]);
    if (daily <= 0 && task <= 0) return undefined;
    return new CostGuard({ maxDailyUsd: daily, maxPerTaskUsd: task, tracker });
  }

  /**
   * Throw if the next call would (definitely) exceed a cap. Optional
   * `estimateUsd` is the caller's pre-call estimate; we add it to the
   * counters and check. Without an estimate we just check
   * already-recorded usage, which catches caps after each call lands.
   */
  beforeCall(taskId: string, estimateUsd = 0): void {
    if (this.maxDailyUsd > 0) {
      const spent = this.currentDailyUsd() + Math.max(0, estimateUsd);
      if (spent >= this.maxDailyUsd) {
        throw new CostCapExceededError("daily", this.maxDailyUsd, spent);
      }
    }
    if (this.maxPerTaskUsd > 0) {
      const spent = this.currentTaskUsd(taskId) + Math.max(0, estimateUsd);
      if (spent >= this.maxPerTaskUsd) {
        throw new CostCapExceededError("task", this.maxPerTaskUsd, spent);
      }
    }
  }

  currentDailyUsd(): number {
    return this.tracker.todayCost();
  }

  currentTaskUsd(taskId: string): number {
    return this.tracker.taskCost(taskId).totalCostUsd;
  }

  /** Snapshot for debugging / metrics. */
  snapshot(): { dailyCapUsd: number; taskCapUsd: number; dailyUsed: number } {
    return {
      dailyCapUsd: this.maxDailyUsd,
      taskCapUsd: this.maxPerTaskUsd,
      dailyUsed: this.currentDailyUsd(),
    };
  }
}

function parseDollar(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}
