/**
 * CronStore — SQLite-backed cron job persistence.
 *
 * Stores job definitions and run history. The actual scheduling loop
 * lives in CronScheduler, which consumes this store.
 *
 * Tables:
 *   cron_jobs  — job definitions (expression, task, timezone, etc.)
 *   cron_runs  — execution log per job (status, result, error)
 */

import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { createLogger } from "../util/logger.js";
import { NotFoundError, ValidationError } from "../util/errors.js";
import { parseCron, nextFire } from "./cronParser.js";

const log = createLogger("cron-store");

// ── Row types ──────────────────────────────────────────────────────

export interface CronJob {
  readonly id: string;
  readonly name: string;
  readonly expression: string;
  readonly task: string;
  readonly enabled: boolean;
  readonly timezone: string;
  readonly delivery: Record<string, unknown> | null;
  readonly lastRunAt: number | null;
  readonly nextRunAt: number | null;
  readonly createdAt: number;
}

export interface CronRun {
  readonly id: string;
  readonly jobId: string;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly status: "success" | "error" | "running";
  readonly result: string | null;
  readonly error: string | null;
}

// ── Input types ────────────────────────────────────────────────────

export interface AddJobOpts {
  readonly name: string;
  readonly expression: string;
  readonly task: string;
  readonly enabled?: boolean;
  readonly timezone?: string;
  readonly delivery?: Record<string, unknown>;
}

export interface UpdateJobOpts {
  readonly name?: string;
  readonly expression?: string;
  readonly task?: string;
  readonly enabled?: boolean;
  readonly timezone?: string;
  readonly delivery?: Record<string, unknown> | null;
}

// ── Raw DB rows ────────────────────────────────────────────────────

interface JobRow {
  id: string;
  name: string;
  expression: string;
  task: string;
  enabled: number;
  timezone: string;
  delivery_json: string | null;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
}

interface RunRow {
  id: string;
  job_id: string;
  started_at: number;
  completed_at: number | null;
  status: string;
  result: string | null;
  error: string | null;
}

// ── Store ──────────────────────────────────────────────────────────

export class CronStore {
  private readonly stmts: ReturnType<CronStore["prepareStatements"]>;

  constructor(private readonly db: Database.Database) {
    this.createTables();
    this.stmts = this.prepareStatements();
    log.debug("cron store initialized");
  }

  // ── Jobs ────────────────────────────────────────────────────────

  addJob(opts: AddJobOpts): CronJob {
    // Validate expression before persisting.
    const fields = parseCron(opts.expression);
    const tz = opts.timezone ?? "UTC";
    const now = Date.now();
    const id = randomUUID();

    const computedNext = opts.enabled !== false
      ? nextFire(fields, new Date(now), tz) ?? null
      : null;

    const deliveryJson = opts.delivery ? JSON.stringify(opts.delivery) : null;

    this.stmts.insertJob.run(
      id,
      opts.name,
      opts.expression,
      opts.task,
      opts.enabled !== false ? 1 : 0,
      tz,
      deliveryJson,
      null,
      computedNext,
      now,
    );

    log.info({ id, name: opts.name, expression: opts.expression }, "job added");
    return this.getJob(id)!;
  }

  listJobs(): readonly CronJob[] {
    const rows = this.stmts.listJobs.all() as JobRow[];
    return rows.map(rowToJob);
  }

  getJob(id: string): CronJob | undefined {
    const row = this.stmts.getJob.get(id) as JobRow | undefined;
    return row ? rowToJob(row) : undefined;
  }

  updateJob(id: string, updates: UpdateJobOpts): CronJob {
    const existing = this.getJob(id);
    if (!existing) throw new NotFoundError(`Cron job not found: ${id}`);

    // Validate new expression if provided.
    const expression = updates.expression ?? existing.expression;
    const timezone = updates.timezone ?? existing.timezone;
    const enabled = updates.enabled ?? existing.enabled;
    const fields = parseCron(expression);

    // Recompute next_run_at.
    const computedNext = enabled
      ? nextFire(fields, new Date(), timezone) ?? null
      : null;

    const deliveryJson = updates.delivery !== undefined
      ? (updates.delivery !== null ? JSON.stringify(updates.delivery) : null)
      : (existing.delivery !== null ? JSON.stringify(existing.delivery) : null);

    this.stmts.updateJob.run(
      updates.name ?? existing.name,
      expression,
      updates.task ?? existing.task,
      enabled ? 1 : 0,
      timezone,
      deliveryJson,
      computedNext,
      id,
    );

    log.info({ id, updates: Object.keys(updates) }, "job updated");
    return this.getJob(id)!;
  }

  deleteJob(id: string): boolean {
    // Children first — cron_runs.job_id has a FK without ON DELETE
    // CASCADE, so deleting the job while runs still reference it
    // errors with "FOREIGN KEY constraint failed".
    this.stmts.deleteJobRuns.run(id);
    const info = this.stmts.deleteJob.run(id);
    if (info.changes > 0) {
      log.info({ id }, "job deleted");
      return true;
    }
    return false;
  }

  // ── Runs ────────────────────────────────────────────────────────

  getJobRuns(jobId: string, limit = 50): readonly CronRun[] {
    const rows = this.stmts.getJobRuns.all(jobId, limit) as RunRow[];
    return rows.map(rowToRun);
  }

  recordRun(
    jobId: string,
    status: CronRun["status"],
    result?: string,
    error?: string,
  ): CronRun {
    const id = randomUUID();
    const now = Date.now();
    const completedAt = status !== "running" ? now : null;

    this.stmts.insertRun.run(id, jobId, now, completedAt, status, result ?? null, error ?? null);

    // Update job's last_run_at and recompute next_run_at.
    const job = this.getJob(jobId);
    if (job) {
      const fields = parseCron(job.expression);
      const computedNext = job.enabled
        ? nextFire(fields, new Date(now), job.timezone) ?? null
        : null;
      this.stmts.updateJobRunMeta.run(now, computedNext, jobId);
    }

    return { id, jobId, startedAt: now, completedAt, status, result: result ?? null, error: error ?? null };
  }

  /**
   * Recent runs for a given job, newest first. Used by Heartbeat to
   * detect consecutive-error patterns that suggest a broken job.
   */
  listRuns(jobId: string, limit = 20): readonly CronRun[] {
    const rows = this.stmts.getJobRuns.all(jobId, Math.min(limit, 100)) as Array<RunRow>;
    return rows.map((r) => ({
      id: r.id,
      jobId: r.job_id,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      status: r.status as CronRun["status"],
      result: r.result,
      error: r.error,
    }));
  }

  /**
   * Return all enabled jobs whose next_run_at <= the given epoch.
   * CronScheduler calls this every tick.
   */
  dueJobs(now: number): readonly CronJob[] {
    const rows = this.stmts.dueJobs.all(now) as JobRow[];
    return rows.map(rowToJob);
  }

  // ── Internals ───────────────────────────────────────────────────

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        expression   TEXT NOT NULL,
        task         TEXT NOT NULL,
        enabled      INTEGER NOT NULL DEFAULT 1,
        timezone     TEXT NOT NULL DEFAULT 'UTC',
        delivery_json TEXT,
        last_run_at  INTEGER,
        next_run_at  INTEGER,
        created_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cron_runs (
        id           TEXT PRIMARY KEY,
        job_id       TEXT NOT NULL REFERENCES cron_jobs(id),
        started_at   INTEGER NOT NULL,
        completed_at INTEGER,
        status       TEXT NOT NULL,
        result       TEXT,
        error        TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id);
      CREATE INDEX IF NOT EXISTS idx_cron_jobs_next ON cron_jobs(next_run_at) WHERE enabled = 1;
    `);
  }

  private prepareStatements() {
    return {
      insertJob: this.db.prepare(
        `INSERT INTO cron_jobs (id, name, expression, task, enabled, timezone, delivery_json, last_run_at, next_run_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      listJobs: this.db.prepare("SELECT * FROM cron_jobs ORDER BY created_at DESC"),
      getJob: this.db.prepare("SELECT * FROM cron_jobs WHERE id = ?"),
      updateJob: this.db.prepare(
        `UPDATE cron_jobs SET name = ?, expression = ?, task = ?, enabled = ?, timezone = ?, delivery_json = ?, next_run_at = ?
         WHERE id = ?`,
      ),
      deleteJob: this.db.prepare("DELETE FROM cron_jobs WHERE id = ?"),
      deleteJobRuns: this.db.prepare("DELETE FROM cron_runs WHERE job_id = ?"),
      getJobRuns: this.db.prepare(
        "SELECT * FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?",
      ),
      insertRun: this.db.prepare(
        `INSERT INTO cron_runs (id, job_id, started_at, completed_at, status, result, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      updateJobRunMeta: this.db.prepare(
        "UPDATE cron_jobs SET last_run_at = ?, next_run_at = ? WHERE id = ?",
      ),
      dueJobs: this.db.prepare(
        "SELECT * FROM cron_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?",
      ),
    } as const;
  }
}

// ── Row mappers ────────────────────────────────────────────────────

function rowToJob(row: JobRow): CronJob {
  let delivery: Record<string, unknown> | null = null;
  if (row.delivery_json) {
    try {
      delivery = JSON.parse(row.delivery_json) as Record<string, unknown>;
    } catch {
      log.warn({ id: row.id }, "corrupt delivery_json, treating as null");
    }
  }
  return {
    id: row.id,
    name: row.name,
    expression: row.expression,
    task: row.task,
    enabled: row.enabled === 1,
    timezone: row.timezone,
    delivery,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
  };
}

function rowToRun(row: RunRow): CronRun {
  return {
    id: row.id,
    jobId: row.job_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status as CronRun["status"],
    result: row.result,
    error: row.error,
  };
}
