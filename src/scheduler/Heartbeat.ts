/**
 * Heartbeat — proactive self-check pulse + optional user-defined cadence.
 *
 * Two modes:
 *   1. Proactive scan every `proactiveIntervalMs` (default 4h). Looks at
 *      goals / cron / watchers / tasks for anomalies. If anything's off,
 *      enqueues a single agent turn with the findings. Silent otherwise —
 *      no wasted tokens.
 *   2. User HEARTBEAT.md. If the file exists and changed since last
 *      check, enqueue a turn that asks the agent to follow those
 *      instructions. Dedup'd against previous content for 24 h.
 *
 * Active-hours window (default 08:00-22:00 host time) keeps the
 * heartbeat quiet overnight. User-defined HEARTBEAT.md only fires in
 * daemon mode — interactive use is already "the user is there".
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { TaskRunner } from "../core/TaskRunner.js";
import type { CronStore } from "../cron/CronStore.js";
import type { GoalStore } from "../goals/GoalStore.js";
import type { TaskStore } from "../tasks/TaskStore.js";
import type { WatcherStore } from "../watchers/WatcherStore.js";
import { nextFire, parseCron } from "../cron/cronParser.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("heartbeat");

const DEFAULT_INTERVAL_MINUTES = 30;
const DEFAULT_PROACTIVE_MINUTES = 240; // 4 hours
const TICK_CAP_MS = 5 * 60 * 1000;      // never tick slower than 5 min
const SILENT_WATCHER_DAYS = 7;
const OVERDUE_GOAL_MS = 60 * 60 * 1000; // flag if next fire is > 1h overdue
const BROKEN_CRON_ERR_THRESHOLD = 3;
const FAILED_TASK_WINDOW_MS = 24 * 60 * 60 * 1000;

type Finding =
  | { type: "OVERDUE_GOAL"; message: string }
  | { type: "BROKEN_CRON"; message: string }
  | { type: "SILENT_WATCHER"; message: string }
  | { type: "FAILED_TASKS"; message: string };

export interface HeartbeatOptions {
  readonly rootDir: string;
  readonly daemonMode: boolean;
  /** User heartbeat cadence (min). Default 30. */
  readonly intervalMinutes?: number;
  /** Proactive scan cadence (min). Default 240. */
  readonly proactiveIntervalMinutes?: number;
  /** "08:00" etc. Default 08:00. */
  readonly activeHourStart?: string;
  /** "22:00" etc. Default 22:00. */
  readonly activeHourEnd?: string;
  /** IANA timezone for active-hour window. Default host. */
  readonly activeTimezone?: string;
  /** Live setting check — read each tick so the user can flip the
   *  HEARTBEAT_ENABLED setting without restarting. Default: always on. */
  readonly enabledFn?: () => boolean;
}

export interface HeartbeatStats {
  readonly running: boolean;
  readonly intervalMinutes: number;
  readonly proactiveIntervalMinutes: number;
  readonly activeHours: string;
  readonly timezone: string;
  readonly lastCheckAt: number | null;
  readonly lastProactiveAt: number | null;
  readonly checkCount: number;
}

export interface HeartbeatDeps {
  readonly runner: TaskRunner;
  readonly goals: GoalStore;
  readonly cron: CronStore;
  readonly watchers: WatcherStore;
  readonly tasks: TaskStore;
}

export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private _checkCount = 0;
  private _lastCheckAt: number | null = null;
  private _lastProactiveAt: number | null = null;
  private _lastContentHash: string | null = null;
  private _lastContentAt = 0;

  private readonly heartbeatPath: string;
  private readonly intervalMs: number;
  private readonly proactiveIntervalMs: number;
  private readonly activeStart: string;
  private readonly activeEnd: string;
  private readonly activeTz: string | undefined;
  private readonly daemonMode: boolean;
  private readonly enabledFn: () => boolean;

  constructor(private readonly deps: HeartbeatDeps, opts: HeartbeatOptions) {
    this.heartbeatPath = join(opts.rootDir, "HEARTBEAT.md");
    this.daemonMode = opts.daemonMode;
    this.intervalMs = (opts.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES) * 60_000;
    this.proactiveIntervalMs = (opts.proactiveIntervalMinutes ?? DEFAULT_PROACTIVE_MINUTES) * 60_000;
    this.activeStart = opts.activeHourStart ?? process.env["HEARTBEAT_ACTIVE_START"] ?? "08:00";
    this.activeEnd = opts.activeHourEnd ?? process.env["HEARTBEAT_ACTIVE_END"] ?? "22:00";
    this.activeTz = opts.activeTimezone ?? process.env["HEARTBEAT_TIMEZONE"] ?? undefined;
    this.enabledFn = opts.enabledFn ?? (() => true);
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    const tickMs = Math.min(this.intervalMs, TICK_CAP_MS);
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref?.();
    // first fire 2 minutes in so startup surges don't trigger a scan immediately
    setTimeout(() => void this.tick(), 120_000).unref?.();
    log.info({
      intervalMinutes: this.intervalMs / 60_000,
      proactiveIntervalMinutes: this.proactiveIntervalMs / 60_000,
      active: `${this.activeStart}-${this.activeEnd}`,
      tz: this.activeTz ?? "host",
    }, "heartbeat started");
  }

  stop(): void {
    this._running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    log.info("heartbeat stopped");
  }

  stats(): HeartbeatStats {
    return {
      running: this._running,
      intervalMinutes: this.intervalMs / 60_000,
      proactiveIntervalMinutes: this.proactiveIntervalMs / 60_000,
      activeHours: `${this.activeStart}-${this.activeEnd}`,
      timezone: this.activeTz ?? "host",
      lastCheckAt: this._lastCheckAt,
      lastProactiveAt: this._lastProactiveAt,
      checkCount: this._checkCount,
    };
  }

  /** One cycle. Exposed for tests. */
  async tick(): Promise<void> {
    if (!this._running) return;
    // Live-read the HEARTBEAT_ENABLED setting on every tick so the user
    // can flip it from the UI and the next tick respects the new value
    // without a restart.
    if (!this.enabledFn()) return;
    if (!this.isActiveHour()) return;
    await this.proactiveCheck();
    if (this.daemonMode) await this.userHeartbeat();
  }

  // ── Proactive checks ────────────────────────────────────────────────

  private async proactiveCheck(): Promise<void> {
    const now = Date.now();
    if (this._lastProactiveAt && (now - this._lastProactiveAt) < this.proactiveIntervalMs) return;
    this._lastProactiveAt = now;

    const findings: Finding[] = [];
    try { findings.push(...this.overdueGoals()); } catch (e) { log.debug({ err: (e as Error).message }, "overdue-goals check failed"); }
    try { findings.push(...this.brokenCrons()); } catch (e) { log.debug({ err: (e as Error).message }, "broken-crons check failed"); }
    try { findings.push(...this.silentWatchers()); } catch (e) { log.debug({ err: (e as Error).message }, "silent-watchers check failed"); }
    try { findings.push(...this.failedTasks()); } catch (e) { log.debug({ err: (e as Error).message }, "failed-tasks check failed"); }

    if (findings.length === 0) {
      log.info("proactive check — all clear");
      return;
    }

    const body = findings.map((f, i) => `${i + 1}. [${f.type}] ${f.message}`).join("\n");
    const input = [
      "[Proactive Check] The system detected issues that may need attention. Review each finding and take action.",
      "",
      "FINDINGS:",
      body,
      "",
      "For each finding:",
      "- If you can fix it, fix it (retry a failed task, resume a paused goal, rotate a watcher token, etc.).",
      "- If you can't fix it, notify the user via replyToUser() with a clear summary.",
      "- If informational only, note it and move on.",
      "",
      "If nothing actually needs action after review, respond with just HEARTBEAT_OK.",
      "",
      `Current time: ${new Date().toISOString()}`,
    ].join("\n");

    log.info({ count: findings.length }, "proactive findings — enqueuing task");
    // send() injects into a running "main" loop instead of spawning a parallel one.
    this.deps.runner.send({
      input,
      sessionId: "main",
    });
  }

  private overdueGoals(): Finding[] {
    const out: Finding[] = [];
    const now = Date.now();
    for (const g of this.deps.goals.activeGoals()) {
      if (!g.checkCron || !g.lastCheckedAt) continue;
      try {
        const fields = parseCron(g.checkCron);
        const next = nextFire(fields, new Date(g.lastCheckedAt), "UTC");
        if (next === undefined) continue;
        const overdueMs = now - next;
        if (overdueMs > OVERDUE_GOAL_MS) {
          const hours = (overdueMs / 3_600_000).toFixed(1);
          out.push({
            type: "OVERDUE_GOAL",
            message: `Goal "${g.title}" (${g.id.slice(0, 8)}) is ${hours}h overdue.`,
          });
        }
      } catch {
        // malformed cron — skip silently; validator should've caught it
      }
    }
    return out;
  }

  private brokenCrons(): Finding[] {
    const out: Finding[] = [];
    for (const job of this.deps.cron.listJobs()) {
      if (!job.enabled) continue;
      const runs = this.deps.cron.listRuns(job.id, BROKEN_CRON_ERR_THRESHOLD);
      if (runs.length < BROKEN_CRON_ERR_THRESHOLD) continue;
      const allErrored = runs.every((r) => r.status === "error");
      if (!allErrored) continue;
      const lastErr = (runs[0]?.error ?? "unknown").slice(0, 100);
      out.push({
        type: "BROKEN_CRON",
        message: `Cron "${job.name}" has ${BROKEN_CRON_ERR_THRESHOLD}+ consecutive errors. Last: ${lastErr}`,
      });
    }
    return out;
  }

  private silentWatchers(): Finding[] {
    const out: Finding[] = [];
    const cutoff = Date.now() - SILENT_WATCHER_DAYS * 24 * 60 * 60_000;
    for (const w of this.deps.watchers.list()) {
      if (!w.enabled || w.triggerCount === 0) continue;
      if (w.lastTriggeredAt === null) continue;
      if (w.lastTriggeredAt < cutoff) {
        const days = Math.floor((Date.now() - w.lastTriggeredAt) / (24 * 60 * 60_000));
        out.push({
          type: "SILENT_WATCHER",
          message: `Watcher "${w.name}" hasn't fired in ${days} days (total fires: ${w.triggerCount}). Source may have stopped sending.`,
        });
      }
    }
    return out;
  }

  private failedTasks(): Finding[] {
    const out: Finding[] = [];
    const rows = this.deps.tasks.recentFailed(Date.now() - FAILED_TASK_WINDOW_MS, 5);
    if (rows.length === 0) return out;
    const summary = rows
      .map((t) => `${t.id.slice(0, 8)}: "${(t.input ?? "").slice(0, 60)}…" — ${(t.error ?? "unknown").slice(0, 80)}`)
      .join("\n  ");
    out.push({
      type: "FAILED_TASKS",
      message: `${rows.length} task(s) failed in the last 24h:\n  ${summary}`,
    });
    return out;
  }

  // ── User HEARTBEAT.md ──────────────────────────────────────────────

  private async userHeartbeat(): Promise<void> {
    if (!existsSync(this.heartbeatPath)) return;
    let instructions: string;
    try {
      instructions = readFileSync(this.heartbeatPath, "utf-8").trim();
    } catch (e) {
      log.warn({ err: (e as Error).message }, "HEARTBEAT.md read failed");
      return;
    }
    if (!instructions) return;

    const contentHash = createHash("sha256").update(instructions).digest("hex");
    const now = Date.now();
    if (contentHash === this._lastContentHash && (now - this._lastContentAt) < 24 * 60 * 60_000) return;
    this._lastContentHash = contentHash;
    this._lastContentAt = now;

    this._checkCount++;
    this._lastCheckAt = now;
    log.info({ check: this._checkCount }, "user heartbeat fired");

    // send() injects into a running "main" loop instead of spawning a parallel one.
    this.deps.runner.send({
      input: [
        `[Heartbeat check #${this._checkCount}] Follow HEARTBEAT.md strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`,
        "",
        "Instructions from HEARTBEAT.md:",
        instructions,
        "",
        `Current time: ${new Date().toISOString()}`,
      ].join("\n"),
      sessionId: "main",
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private isActiveHour(): boolean {
    const now = new Date();
    let h = now.getHours();
    let m = now.getMinutes();
    if (this.activeTz) {
      try {
        const fmt = now.toLocaleTimeString("en-US", {
          timeZone: this.activeTz,
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
        });
        const [hh, mm] = fmt.split(":").map(Number);
        if (hh !== undefined && mm !== undefined) { h = hh; m = mm; }
      } catch { /* fallback to host */ }
    }
    const cur = h * 60 + m;
    const start = parseHm(this.activeStart);
    const end = parseHm(this.activeEnd);
    return cur >= start && cur < end;
  }
}

function parseHm(s: string): number {
  if (s.includes(":")) {
    const [h, m] = s.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  }
  return Number.parseInt(s, 10) * 60;
}
