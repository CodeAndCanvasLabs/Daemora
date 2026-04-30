/**
 * TeamStore — SQLite persistence for team orchestration.
 *
 * A "team" is a DAG of workers. Each worker can declare blockers
 * (other workers in the same team that must complete first). The
 * TeamRunner queries ready workers, runs them, and feeds results
 * downstream until the DAG is fully resolved.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import { createLogger } from "../util/logger.js";

const log = createLogger("teams.store");

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface TeamRow {
  readonly id: string;
  readonly name: string;
  readonly task: string;
  readonly status: "active" | "completed" | "failed";
  readonly project: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}

export interface WorkerRow {
  readonly id: string;
  readonly teamId: string;
  readonly name: string;
  readonly profile: string | null;
  readonly crew: string | null;
  readonly task: string;
  readonly status: "pending" | "running" | "completed" | "failed";
  readonly result: string | null;
  readonly error: string | null;
  readonly blockedBy: string; // JSON array of worker *names*
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly createdAt: number;
}

export interface CreateTeamOpts {
  readonly name: string;
  readonly task: string;
  readonly project?: string;
  readonly workers: readonly CreateWorkerOpts[];
}

export interface CreateWorkerOpts {
  readonly name: string;
  readonly profile?: string;
  readonly crew?: string;
  readonly task: string;
  readonly blockedByWorkers?: readonly string[];
}

/* ------------------------------------------------------------------ */
/*  Schema                                                             */
/* ------------------------------------------------------------------ */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  task         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  project      TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS team_workers (
  id           TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  profile      TEXT,
  crew         TEXT,
  task         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  result       TEXT,
  error        TEXT,
  blocked_by   TEXT NOT NULL DEFAULT '[]',
  started_at   INTEGER,
  completed_at INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS team_workers_by_team
  ON team_workers (team_id);

CREATE INDEX IF NOT EXISTS team_workers_by_status
  ON team_workers (team_id, status);
`;

/* ------------------------------------------------------------------ */
/*  Store                                                              */
/* ------------------------------------------------------------------ */

export class TeamStore {
  private readonly insertTeam: Database.Statement;
  private readonly updateTeamStatus: Database.Statement;
  private readonly selectTeam: Database.Statement;
  private readonly selectAllTeams: Database.Statement;
  private readonly deleteTeamStmt: Database.Statement;
  private readonly deleteTeamWorkers: Database.Statement;

  private readonly insertWorker: Database.Statement;
  private readonly selectWorkersByTeam: Database.Statement;
  private readonly selectWorkerById: Database.Statement;
  private readonly updateWorkerStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);

    /* Teams */
    this.insertTeam = db.prepare(
      `INSERT INTO teams (id, name, task, status, project, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)`,
    );
    this.updateTeamStatus = db.prepare(
      `UPDATE teams SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
    );
    this.selectTeam = db.prepare(
      `SELECT id, name, task, status, project,
              created_at AS createdAt, updated_at AS updatedAt,
              completed_at AS completedAt
       FROM teams WHERE id = ?`,
    );
    this.selectAllTeams = db.prepare(
      `SELECT id, name, task, status, project,
              created_at AS createdAt, updated_at AS updatedAt,
              completed_at AS completedAt
       FROM teams ORDER BY created_at DESC`,
    );
    this.deleteTeamStmt = db.prepare(`DELETE FROM teams WHERE id = ?`);
    this.deleteTeamWorkers = db.prepare(`DELETE FROM team_workers WHERE team_id = ?`);

    /* Workers */
    this.insertWorker = db.prepare(
      `INSERT INTO team_workers (id, team_id, name, profile, crew, task, status, blocked_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    );
    this.selectWorkersByTeam = db.prepare(
      `SELECT id, team_id AS teamId, name, profile, crew, task, status,
              result, error, blocked_by AS blockedBy,
              started_at AS startedAt, completed_at AS completedAt,
              created_at AS createdAt
       FROM team_workers WHERE team_id = ? ORDER BY created_at ASC`,
    );
    this.selectWorkerById = db.prepare(
      `SELECT id, team_id AS teamId, name, profile, crew, task, status,
              result, error, blocked_by AS blockedBy,
              started_at AS startedAt, completed_at AS completedAt,
              created_at AS createdAt
       FROM team_workers WHERE id = ?`,
    );
    this.updateWorkerStmt = db.prepare(
      `UPDATE team_workers SET status = ?, result = ?, error = ?,
              started_at = COALESCE(started_at, ?), completed_at = ?
       WHERE id = ?`,
    );
  }

  /* ---- Teams ---------------------------------------------------- */

  createTeam(opts: CreateTeamOpts): TeamRow {
    const now = Date.now();
    const teamId = randomUUID();

    // Validate: detect circular dependencies before persisting anything.
    this.validateDAG(opts.workers);

    const txn = this.db.transaction(() => {
      this.insertTeam.run(teamId, opts.name, opts.task, opts.project ?? null, now, now);

      for (const w of opts.workers) {
        this.insertWorker.run(
          randomUUID(),
          teamId,
          w.name,
          w.profile ?? null,
          w.crew ?? null,
          w.task,
          JSON.stringify(w.blockedByWorkers ?? []),
          now,
        );
      }
    });
    txn();

    log.info({ teamId, name: opts.name, workers: opts.workers.length }, "team created");
    return this.getTeam(teamId)!;
  }

  getTeam(id: string): TeamRow | null {
    return (this.selectTeam.get(id) as TeamRow) ?? null;
  }

  listTeams(): readonly TeamRow[] {
    return this.selectAllTeams.all() as TeamRow[];
  }

  deleteTeam(id: string): void {
    const txn = this.db.transaction(() => {
      this.deleteTeamWorkers.run(id);
      this.deleteTeamStmt.run(id);
    });
    txn();
    log.info({ teamId: id }, "team deleted");
  }

  completeTeam(id: string, status: "completed" | "failed"): void {
    const now = Date.now();
    this.updateTeamStatus.run(status, now, now, id);
  }

  /* ---- Workers -------------------------------------------------- */

  getWorkers(teamId: string): readonly WorkerRow[] {
    return this.selectWorkersByTeam.all(teamId) as WorkerRow[];
  }

  getWorker(workerId: string): WorkerRow | null {
    return (this.selectWorkerById.get(workerId) as WorkerRow) ?? null;
  }

  updateWorkerStatus(
    workerId: string,
    status: "running" | "completed" | "failed",
    result?: string,
    error?: string,
  ): void {
    const now = Date.now();
    const startedAt = status === "running" ? now : null;
    const completedAt = status === "completed" || status === "failed" ? now : null;
    this.updateWorkerStmt.run(
      status,
      result?.slice(0, 10_000) ?? null,
      error?.slice(0, 2000) ?? null,
      startedAt,
      completedAt,
      workerId,
    );
  }

  /**
   * Workers whose blockers are all in "completed" status.
   * Only returns workers still in "pending" status.
   */
  getReadyWorkers(teamId: string): readonly WorkerRow[] {
    const workers = this.getWorkers(teamId);

    // Build name → status map for fast lookup.
    const statusByName = new Map<string, string>();
    for (const w of workers) {
      statusByName.set(w.name, w.status);
    }

    return workers.filter((w) => {
      if (w.status !== "pending") return false;
      const blockers: string[] = JSON.parse(w.blockedBy);
      if (blockers.length === 0) return true;
      return blockers.every((name) => statusByName.get(name) === "completed");
    });
  }

  /**
   * True when every worker is in a terminal state (completed or failed).
   */
  isTeamComplete(teamId: string): boolean {
    const workers = this.getWorkers(teamId);
    if (workers.length === 0) return true;
    return workers.every((w) => w.status === "completed" || w.status === "failed");
  }

  /* ---- DAG Validation ------------------------------------------- */

  /**
   * Detect cycles via topological sort (Kahn's algorithm).
   * Throws if the worker dependency graph contains a cycle.
   */
  private validateDAG(workers: readonly CreateWorkerOpts[]): void {
    const names = new Set(workers.map((w) => w.name));

    // Check for duplicate names.
    if (names.size !== workers.length) {
      throw new Error("Duplicate worker names in team definition");
    }

    // Check all blocker references point to real workers.
    for (const w of workers) {
      for (const dep of w.blockedByWorkers ?? []) {
        if (!names.has(dep)) {
          throw new Error(
            `Worker "${w.name}" depends on unknown worker "${dep}"`,
          );
        }
        if (dep === w.name) {
          throw new Error(`Worker "${w.name}" cannot depend on itself`);
        }
      }
    }

    // Kahn's algorithm for cycle detection.
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const w of workers) {
      inDegree.set(w.name, 0);
      dependents.set(w.name, []);
    }
    for (const w of workers) {
      const blockers = w.blockedByWorkers ?? [];
      inDegree.set(w.name, blockers.length);
      for (const dep of blockers) {
        dependents.get(dep)!.push(w.name);
      }
    }

    const queue: string[] = [];
    for (const [name, deg] of inDegree) {
      if (deg === 0) queue.push(name);
    }

    let processed = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      processed++;
      for (const dep of dependents.get(current)!) {
        const newDeg = inDegree.get(dep)! - 1;
        inDegree.set(dep, newDeg);
        if (newDeg === 0) queue.push(dep);
      }
    }

    if (processed !== workers.length) {
      throw new Error(
        "Circular dependency detected in team worker graph",
      );
    }
  }
}
