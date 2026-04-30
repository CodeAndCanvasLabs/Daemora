/**
 * AuditLog — append-only audit trail for sensitive operations.
 *
 * Every tool call, secret access, file mutation, command execution,
 * and crew spawn gets a permanent record here. The table is append-only:
 * no UPDATE or DELETE statements exist.
 *
 * Table: audit_log
 */

import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { createLogger } from "../util/logger.js";

const log = createLogger("audit-log");

// ── Types ──────────────────────────────────────────────────────────

export type AuditAction =
  | "tool_call"
  | "secret_read"
  | "file_write"
  | "command_exec"
  | "email_sent"
  | "crew_spawn"
  | "cron_fire"
  | "watcher_trigger"
  | "goal_check"
  | "session_create"
  | "vault_unlock"
  | "vault_lock";

export type AuditRisk = "low" | "medium" | "high" | "critical";

export interface AuditEntry {
  readonly id: string;
  readonly action: AuditAction;
  readonly actor: string;
  readonly target: string | null;
  readonly detail: string | null;
  readonly risk: AuditRisk;
  readonly createdAt: number;
}

// ── Raw DB row ─────────────────────────────────────────────────────

interface AuditRow {
  id: string;
  action: string;
  actor: string;
  target: string | null;
  detail: string | null;
  risk: string;
  created_at: number;
}

// ── Valid sets for runtime validation ──────────────────────────────

const VALID_ACTIONS = new Set<AuditAction>([
  "tool_call",
  "secret_read",
  "file_write",
  "command_exec",
  "email_sent",
  "crew_spawn",
]);

const VALID_RISKS = new Set<AuditRisk>(["low", "medium", "high", "critical"]);

// ── AuditLog ───────────────────────────────────────────────────────

export class AuditLog {
  private readonly stmts: ReturnType<AuditLog["prepareStatements"]>;

  constructor(private readonly db: Database.Database) {
    this.createTable();
    this.stmts = this.prepareStatements();
    log.debug("audit log initialized");
  }

  /**
   * Append an audit entry. This is the hot path — it should never throw
   * under normal operation (malformed input is clamped, not rejected).
   */
  log(
    action: AuditAction,
    target?: string | null,
    detail?: string | null,
    risk?: AuditRisk,
  ): AuditEntry {
    const id = randomUUID();
    const now = Date.now();

    // Clamp unknown action/risk to safe defaults rather than throwing —
    // an audit failure must never break the operation being audited.
    const safeAction = VALID_ACTIONS.has(action) ? action : "tool_call";
    const safeRisk = risk !== undefined && VALID_RISKS.has(risk) ? risk : "low";
    const safeTarget = target ?? null;
    const safeDetail = detail ?? null;

    try {
      this.stmts.insert.run(id, safeAction, "agent", safeTarget, safeDetail, safeRisk, now);
    } catch (err) {
      // Log but do not propagate — auditing is observability, not control flow.
      log.error({ err, action: safeAction, target: safeTarget }, "failed to write audit entry");
      // Still return the entry object so callers don't need error handling.
    }

    return {
      id,
      action: safeAction,
      actor: "agent",
      target: safeTarget,
      detail: safeDetail,
      risk: safeRisk,
      createdAt: now,
    };
  }

  /**
   * Retrieve the most recent audit entries.
   */
  recent(limit = 100): readonly AuditEntry[] {
    const clamped = Math.max(1, Math.min(limit, 10_000));
    const rows = this.stmts.recent.all(clamped) as AuditRow[];
    return rows.map(rowToEntry);
  }

  /**
   * Full-text search across action, target, and detail columns.
   * Uses SQLite LIKE for simplicity — the audit_log is append-only and
   * relatively small, so a full-text index is unnecessary.
   */
  search(query: string, limit = 100): readonly AuditEntry[] {
    const clamped = Math.max(1, Math.min(limit, 10_000));
    const pattern = `%${escapeLike(query)}%`;
    const rows = this.stmts.search.all(pattern, pattern, pattern, clamped) as AuditRow[];
    return rows.map(rowToEntry);
  }

  /**
   * Count entries by action type, optionally filtered to a time range.
   * Useful for dashboards / rate limiting heuristics.
   */
  countByAction(sinceMs?: number): ReadonlyMap<AuditAction, number> {
    const since = sinceMs ?? 0;
    const rows = this.stmts.countByAction.all(since) as { action: string; cnt: number }[];
    const result = new Map<AuditAction, number>();
    for (const r of rows) {
      if (VALID_ACTIONS.has(r.action as AuditAction)) {
        result.set(r.action as AuditAction, r.cnt);
      }
    }
    return result;
  }

  /**
   * Count entries at or above a given risk level since a timestamp.
   */
  countByRisk(minRisk: AuditRisk, sinceMs?: number): number {
    const since = sinceMs ?? 0;
    const riskLevels = riskAndAbove(minRisk);
    // Build a simple OR query since the risk set is tiny (max 4 values).
    let total = 0;
    for (const r of riskLevels) {
      const row = this.stmts.countRisk.get(r, since) as { cnt: number } | undefined;
      total += row?.cnt ?? 0;
    }
    return total;
  }

  // ── Internals ───────────────────────────────────────────────────

  private createTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id         TEXT PRIMARY KEY,
        action     TEXT NOT NULL,
        actor      TEXT NOT NULL DEFAULT 'agent',
        target     TEXT,
        detail     TEXT,
        risk       TEXT NOT NULL DEFAULT 'low',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
      CREATE INDEX IF NOT EXISTS idx_audit_risk ON audit_log(risk);
    `);
  }

  private prepareStatements() {
    return {
      insert: this.db.prepare(
        `INSERT INTO audit_log (id, action, actor, target, detail, risk, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      recent: this.db.prepare(
        "SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?",
      ),
      search: this.db.prepare(
        `SELECT * FROM audit_log
         WHERE action LIKE ? OR target LIKE ? OR detail LIKE ?
         ORDER BY created_at DESC
         LIMIT ?`,
      ),
      countByAction: this.db.prepare(
        `SELECT action, COUNT(*) AS cnt FROM audit_log
         WHERE created_at >= ?
         GROUP BY action`,
      ),
      countRisk: this.db.prepare(
        "SELECT COUNT(*) AS cnt FROM audit_log WHERE risk = ? AND created_at >= ?",
      ),
    } as const;
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function rowToEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    action: row.action as AuditAction,
    actor: row.actor,
    target: row.target,
    detail: row.detail,
    risk: row.risk as AuditRisk,
    createdAt: row.created_at,
  };
}

/** Escape special LIKE characters so user input is treated literally. */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

const RISK_ORDER: readonly AuditRisk[] = ["low", "medium", "high", "critical"];

/** Return the given risk level and all levels above it. */
function riskAndAbove(minRisk: AuditRisk): readonly AuditRisk[] {
  const idx = RISK_ORDER.indexOf(minRisk);
  if (idx === -1) return ["low", "medium", "high", "critical"];
  return RISK_ORDER.slice(idx);
}
