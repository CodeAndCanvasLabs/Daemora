/**
 * GoalPulse — periodic autonomous goal execution.
 *
 * Every 60 s, checks for active goals whose `checkCron` indicates they
 * are due, enqueues them as tasks via the TaskRunner, and records
 * progress. Consecutive failures (≥ 3 by default) auto-pause a goal.
 *
 * Goals without a `checkCron` are left alone — they're manually tracked.
 */

import type { TaskRunner } from "../core/TaskRunner.js";
import { nextFire, parseCron } from "../cron/cronParser.js";
import type { GoalRow, GoalStore } from "../goals/GoalStore.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("goal-pulse");

const TICK_MS = 60_000;
const DEFAULT_MAX_FAILURES = 3;

export interface GoalPulseOptions {
  /** Max consecutive failures before a goal is auto-paused. Default 3. */
  readonly maxFailures?: number;
  /** How often to check for due goals (ms). Default 60 000. */
  readonly tickMs?: number;
}

export interface GoalPulseStats {
  readonly running: boolean;
  readonly checkCount: number;
  readonly lastCheckAt: number | null;
}

/** In-memory failure counter per goal id — resets on success or restart. */
type FailureCounter = Map<string, number>;

export class GoalPulse {
  private timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private _checkCount = 0;
  private _lastCheckAt: number | null = null;
  private readonly failures: FailureCounter = new Map();
  private readonly maxFailures: number;
  private readonly tickMs: number;

  constructor(
    private readonly goals: GoalStore,
    private readonly runner: TaskRunner,
    opts: GoalPulseOptions = {},
  ) {
    this.maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.tickMs = opts.tickMs ?? TICK_MS;
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    const fire = () => void this.tick().catch((e) => log.error({ err: (e as Error).message }, "goal pulse tick crashed"));
    this.timer = setInterval(fire, this.tickMs);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
    log.info({ tickMs: this.tickMs }, "goal pulse started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this._running = false;
    log.info("goal pulse stopped");
  }

  stats(): GoalPulseStats {
    return { running: this._running, checkCount: this._checkCount, lastCheckAt: this._lastCheckAt };
  }

  /** Run one cycle. Exposed for tests / manual triggers. */
  async tick(): Promise<void> {
    const now = Date.now();
    this._lastCheckAt = now;
    this._checkCount++;

    const due = this.goals.activeGoals().filter((g) => this.isDue(g, now));
    if (due.length === 0) return;
    log.info({ count: due.length }, "due goals found");

    for (const goal of due) {
      try {
        await this.executeGoal(goal);
        this.failures.delete(goal.id);
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        const count = (this.failures.get(goal.id) ?? 0) + 1;
        this.failures.set(goal.id, count);
        log.error({ goalId: goal.id, count, err: msg }, "goal execution failed");
        if (count >= this.maxFailures) {
          this.goals.update(goal.id, { status: "paused", notes: `auto-paused after ${count} consecutive failures` }, true);
          this.failures.delete(goal.id);
          log.warn({ goalId: goal.id }, "goal auto-paused");
        } else {
          this.goals.update(goal.id, {}, true);
        }
      }
    }
  }

  private isDue(goal: GoalRow, now: number): boolean {
    if (!goal.checkCron) return false;
    if (goal.lastCheckedAt === null) return true;
    try {
      const fields = parseCron(goal.checkCron);
      const next = nextFire(fields, new Date(goal.lastCheckedAt), "UTC");
      return next !== undefined && next <= now;
    } catch {
      // Malformed cron — skip silently (shouldn't happen; validated on save).
      return false;
    }
  }

  private async executeGoal(goal: GoalRow): Promise<void> {
    const input = [
      `[Goal Check] Autonomous check — no user present.`,
      `Goal: ${goal.title}`,
      goal.description ? `Description: ${goal.description}` : "",
      goal.notes ? `Notes: ${goal.notes.slice(0, 300)}` : "",
      "",
      "Execute progress toward this goal. Report what you accomplished.",
    ].filter(Boolean).join("\n");

    // send() injects into a running "main" loop if one is active.
    const sendResult = this.runner.send({
      input,
      sessionId: "main",
    });
    if (sendResult.mode === "injected") {
      this.goals.update(goal.id, {}, true);
      log.info(
        { goalId: goal.id, taskId: sendResult.taskId },
        "goal injected into running loop",
      );
      return;
    }
    const terminal = await sendResult.done!;
    if (terminal.status === "failed") {
      throw new Error(terminal.error ?? "goal task failed");
    }
    this.goals.update(goal.id, {}, true);
    log.info({ goalId: goal.id, taskId: sendResult.taskId }, "goal progressed");
  }
}
