/**
 * Cleanup — data retention sweeper.
 *
 * Deletes rows older than `retentionDays` from the high-churn tables
 * (tasks, audit, costs) and stale sub-agent session rows. Main user
 * sessions (no `--` in id) are preserved regardless of age.
 *
 * Configurable:
 *   - retentionDays (constructor arg or CLEANUP_AFTER_DAYS env)
 *   - `0` = never delete anything
 *
 * Intended to run daily via cron. A single sweep is cheap — SQLite
 * handles 100k-row DELETE in tens of milliseconds on a WAL-backed DB.
 */

import type Database from "better-sqlite3";

import { createLogger } from "../util/logger.js";

const log = createLogger("cleanup");

const DEFAULT_DAYS = 30;

export interface CleanupStats {
  readonly tasks: number;
  readonly audit: number;
  readonly costs: number;
  readonly sessions: number;
  readonly total: number;
}

export interface StorageStats {
  readonly tasks: number;
  readonly audit: number;
  readonly costs: number;
  readonly sessions: number;
  readonly retentionDays: number | "never";
}

export class Cleanup {
  readonly retentionDays: number;

  constructor(private readonly db: Database.Database, retentionDays?: number) {
    const envDays = Number.parseInt(process.env["CLEANUP_AFTER_DAYS"] ?? "", 10);
    this.retentionDays = retentionDays ?? (Number.isFinite(envDays) ? envDays : DEFAULT_DAYS);
  }

  run(overrideDays?: number): CleanupStats {
    const days = overrideDays ?? this.retentionDays;
    if (days <= 0) return { tasks: 0, audit: 0, costs: 0, sessions: 0, total: 0 };

    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const stats = {
      tasks: this.deleteOlderThan("task_log", "created_at", cutoffMs),
      audit: this.deleteOlderThan("audit_log", "created_at", cutoffMs),
      costs: this.deleteOlderThan("cost_entries", "created_at", cutoffMs),
      sessions: this.deleteStaleSubSessions(cutoffMs),
    };
    const total = stats.tasks + stats.audit + stats.costs + stats.sessions;
    log.info({ ...stats, total, retentionDays: days }, "cleanup sweep complete");
    return { ...stats, total };
  }

  /**
   * Delete finished tasks (completed/failed) regardless of age. Useful
   * when the user hits "clear history" in the UI.
   */
  deleteCompletedTasks(): number {
    try {
      const info = this.db.prepare(
        `DELETE FROM task_log WHERE status IN ('completed', 'failed', 'cancelled')`,
      ).run();
      return info.changes;
    } catch (e) {
      log.warn({ err: (e as Error).message }, "deleteCompletedTasks failed");
      return 0;
    }
  }

  stats(): StorageStats {
    return {
      tasks: this.count("task_log"),
      audit: this.count("audit_log"),
      costs: this.count("cost_entries"),
      sessions: this.count("sessions"),
      retentionDays: this.retentionDays > 0 ? this.retentionDays : "never",
    };
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private deleteOlderThan(table: string, col: string, cutoffMs: number): number {
    try {
      return this.db.prepare(`DELETE FROM ${table} WHERE ${col} < ?`).run(cutoffMs).changes;
    } catch (e) {
      // Table may not exist yet on a fresh DB — treat as 0 rows removed.
      log.debug({ table, err: (e as Error).message }, "cleanup skipped (table missing?)");
      return 0;
    }
  }

  /**
   * Sub-agent / crew sessions carry an id like `parent--child--…`.
   * They pile up on active installs; main user sessions (no `--`)
   * are always preserved regardless of age.
   */
  private deleteStaleSubSessions(cutoffMs: number): number {
    try {
      // Messages first (FK cascade usually handles it; being explicit is safe).
      this.db.prepare(
        `DELETE FROM session_messages WHERE session_id IN (
           SELECT id FROM sessions WHERE id LIKE '%--%' AND updated_at < ?
         )`,
      ).run(cutoffMs);
      const info = this.db.prepare(
        `DELETE FROM sessions WHERE id LIKE '%--%' AND updated_at < ?`,
      ).run(cutoffMs);
      return info.changes;
    } catch (e) {
      log.debug({ err: (e as Error).message }, "sub-session cleanup skipped");
      return 0;
    }
  }

  private count(table: string): number {
    try {
      const row = this.db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number } | undefined;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }
}
