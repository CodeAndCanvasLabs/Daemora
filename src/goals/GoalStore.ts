/**
 * GoalStore — persistent goals with autonomous check scheduling.
 *
 * A goal is a high-level objective the agent tracks over time.
 * The agent periodically checks if goals are met and reports progress.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import { createLogger } from "../util/logger.js";

const log = createLogger("goals");

export interface GoalRow {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: "active" | "completed" | "paused" | "failed";
  readonly checkCron: string | null;
  readonly lastCheckedAt: number | null;
  readonly completedAt: number | null;
  readonly progress: number;
  readonly notes: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS goals (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'active',
  check_cron      TEXT,
  last_checked_at INTEGER,
  completed_at    INTEGER,
  progress        INTEGER NOT NULL DEFAULT 0,
  notes           TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
`;

export class GoalStore {
  private readonly insertStmt: Database.Statement;
  private readonly selectAll: Database.Statement;
  private readonly selectOne: Database.Statement;
  private readonly updateStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);

    this.insertStmt = db.prepare(
      `INSERT INTO goals (id, title, description, status, check_cron, progress, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.selectAll = db.prepare(
      `SELECT id, title, description, status, check_cron AS checkCron,
              last_checked_at AS lastCheckedAt, completed_at AS completedAt,
              progress, notes, created_at AS createdAt, updated_at AS updatedAt
       FROM goals ORDER BY created_at DESC`,
    );
    this.selectOne = db.prepare(
      `SELECT id, title, description, status, check_cron AS checkCron,
              last_checked_at AS lastCheckedAt, completed_at AS completedAt,
              progress, notes, created_at AS createdAt, updated_at AS updatedAt
       FROM goals WHERE id = ?`,
    );
    this.updateStmt = db.prepare(
      `UPDATE goals SET title=?, description=?, status=?, check_cron=?, progress=?, notes=?, updated_at=?,
              completed_at=CASE WHEN ?='completed' THEN ? ELSE completed_at END,
              last_checked_at=CASE WHEN ?=1 THEN ? ELSE last_checked_at END
       WHERE id=?`,
    );
    this.deleteStmt = db.prepare(`DELETE FROM goals WHERE id = ?`);
  }

  create(opts: { title: string; description?: string; checkCron?: string }): GoalRow {
    const id = randomUUID();
    const now = Date.now();
    this.insertStmt.run(id, opts.title, opts.description ?? "", "active", opts.checkCron ?? null, 0, "", now, now);
    log.info({ id, title: opts.title }, "goal created");
    return this.get(id)!;
  }

  list(): readonly GoalRow[] {
    return this.selectAll.all() as GoalRow[];
  }

  get(id: string): GoalRow | null {
    return (this.selectOne.get(id) as GoalRow) ?? null;
  }

  update(id: string, opts: Partial<Pick<GoalRow, "title" | "description" | "status" | "checkCron" | "progress" | "notes">>, markChecked = false): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    const now = Date.now();
    const newStatus = opts.status ?? existing.status;
    this.updateStmt.run(
      opts.title ?? existing.title,
      opts.description ?? existing.description,
      newStatus,
      opts.checkCron !== undefined ? opts.checkCron : existing.checkCron,
      opts.progress ?? existing.progress,
      opts.notes ?? existing.notes,
      now,
      newStatus, now, // completed_at CASE
      markChecked ? 1 : 0, now, // last_checked_at CASE
      id,
    );
    return true;
  }

  delete(id: string): boolean {
    return this.deleteStmt.run(id).changes > 0;
  }

  activeGoals(): readonly GoalRow[] {
    return this.list().filter((g) => g.status === "active");
  }
}
