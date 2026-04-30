/**
 * CronScheduler — in-memory timer that polls CronStore every 30 s
 * for due jobs and fires a callback for each.
 *
 * Lifecycle:
 *   const sched = new CronScheduler(store, async (job) => { ... });
 *   sched.start();
 *   // later
 *   sched.stop();
 *
 * The callback receives the CronJob and is responsible for execution.
 * CronScheduler records runs (started / success / error) automatically.
 */

import { createLogger } from "../util/logger.js";
import { CronStore, type CronJob } from "./CronStore.js";

const log = createLogger("cron-scheduler");

const TICK_INTERVAL_MS = 30_000;

export type CronCallback = (job: CronJob) => Promise<string | void>;

export class CronScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Track in-flight jobs to avoid double-firing within the same tick. */
  private readonly inflight = new Set<string>();

  constructor(
    private readonly store: CronStore,
    private readonly onDue: CronCallback,
  ) {}

  /** Start the polling loop. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.running = true;
    log.info({ intervalMs: TICK_INTERVAL_MS }, "scheduler started");

    // Fire immediately on start, then every TICK_INTERVAL_MS.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);

    // Don't keep the process alive just for cron.
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  /** Stop the polling loop. In-flight jobs are awaited on the next tick. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.running = false;
    log.info("scheduler stopped");
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Number of jobs currently executing. Useful for status tooling. */
  get inflightCount(): number {
    return this.inflight.size;
  }

  /**
   * Run a specific job now, out-of-band with the normal tick.
   * Used by the `cron` tool's `run` action. Respects in-flight
   * tracking so it can't double-fire alongside the polling loop.
   */
  async forceRun(jobId: string): Promise<void> {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`Cron job not found: ${jobId}`);
    if (this.inflight.has(jobId)) {
      throw new Error(`Cron job ${jobId} is already running`);
    }
    await this.execute(job);
  }

  // ── Internal ────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (!this.running) return;

    const now = Date.now();
    let dueJobs: readonly CronJob[];

    try {
      dueJobs = this.store.dueJobs(now);
    } catch (err) {
      log.error({ err }, "failed to query due jobs");
      return;
    }

    if (dueJobs.length === 0) return;
    log.debug({ count: dueJobs.length }, "due jobs found");

    for (const job of dueJobs) {
      // Skip if already executing from a previous tick.
      if (this.inflight.has(job.id)) {
        log.debug({ jobId: job.id }, "skipping — still in-flight");
        continue;
      }
      void this.execute(job);
    }
  }

  private async execute(job: CronJob): Promise<void> {
    this.inflight.add(job.id);
    const runStart = Date.now();
    log.info({ jobId: job.id, name: job.name }, "executing cron job");

    // Record a "running" entry so the UI can show in-progress state.
    this.store.recordRun(job.id, "running");

    try {
      const result = await this.onDue(job);
      const resultStr = result ?? "ok";
      this.store.recordRun(job.id, "success", resultStr);
      log.info(
        { jobId: job.id, name: job.name, durationMs: Date.now() - runStart },
        "cron job completed",
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.store.recordRun(job.id, "error", undefined, errorMsg);
      log.error(
        { jobId: job.id, name: job.name, err, durationMs: Date.now() - runStart },
        "cron job failed",
      );
    } finally {
      this.inflight.delete(job.id);
    }
  }
}
