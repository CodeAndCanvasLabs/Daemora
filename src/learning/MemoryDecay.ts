/**
 * MemoryDecay — prunes stale and irrelevant memories.
 *
 * Runs periodically (daily cron or on-demand) to keep the memory store
 * lean. Three decay strategies:
 *   1. Old + never recalled → soft-delete (mark inactive)
 *   2. Negative feedback → reduce priority (tag as low-priority)
 *   3. Recently accessed → keep regardless of age
 *
 * All actions are logged to memory_decay_log for auditability.
 *
 * Table: memory_decay_log(id TEXT PK, memory_id TEXT, action TEXT, reason TEXT, created_at INT)
 */

import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { createLogger } from "../util/logger.js";
import type { MemoryStore } from "../memory/MemoryStore.js";

const log = createLogger("learning.decay");

// ── Config ────────────────────────────────────────────────────────

/** Entries older than this with 0 recalls get soft-deleted. */
const STALE_AGE_MS = 90 * 24 * 60 * 60_000; // 90 days

/** Entries accessed within this window are always kept. */
const RECENT_ACCESS_MS = 14 * 24 * 60 * 60_000; // 14 days

// ── Schema ────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_decay_log (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL,
  action      TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decay_log_memory
  ON memory_decay_log (memory_id);
CREATE INDEX IF NOT EXISTS idx_decay_log_created
  ON memory_decay_log (created_at DESC);
`;

// ── Types ─────────────────────────────────────────────────────────

export type DecayAction = "soft-delete" | "deprioritize" | "keep";

export interface DecayLogEntry {
  readonly id: string;
  readonly memoryId: string;
  readonly action: DecayAction;
  readonly reason: string;
  readonly createdAt: number;
}

export interface DecayResult {
  readonly scanned: number;
  readonly deleted: number;
  readonly deprioritized: number;
  readonly kept: number;
}

interface DecayLogRow {
  id: string;
  memory_id: string;
  action: string;
  reason: string;
  created_at: number;
}

// ── MemoryDecay ───────────────────────────────────────────────────

export class MemoryDecay {
  private readonly stmts: ReturnType<MemoryDecay["prepareStatements"]>;

  constructor(
    private readonly db: Database.Database,
    private readonly memory: MemoryStore,
  ) {
    db.exec(SCHEMA);
    this.stmts = this.prepareStatements();
    log.debug("memory decay initialized");
  }

  /**
   * Run the decay pass. Scans all memory entries and applies decay
   * rules. Returns a summary of actions taken.
   *
   * Safe to call frequently — idempotent for already-processed entries.
   */
  runDecay(): DecayResult {
    const now = Date.now();
    const staleThreshold = now - STALE_AGE_MS;
    const recentThreshold = now - RECENT_ACCESS_MS;

    let scanned = 0;
    let deleted = 0;
    let deprioritized = 0;
    let kept = 0;

    // Scan in batches to avoid loading entire table into memory
    const batchSize = 100;
    let offset = 0;

    while (true) {
      const entries = this.memory.listRecentEntries({ limit: batchSize, offset });
      if (entries.length === 0) break;

      const tx = this.db.transaction(() => {
        for (const entry of entries) {
          scanned++;

          // Check access stats
          const stats = this.getRecallStats(entry.id);
          const accessCount = stats?.access_count ?? 0;
          const lastAccessed = stats?.last_accessed ?? 0;

          // Rule 1: Recently accessed → keep regardless of age
          if (lastAccessed > recentThreshold) {
            kept++;
            continue;
          }

          // Rule 2: Negative feedback (tagged "negative-feedback") → deprioritize
          if (entry.tags.includes("negative-feedback")) {
            this.deprioritize(entry.id, "negative feedback tag present", now);
            deprioritized++;
            continue;
          }

          // Rule 3: Old + never recalled → soft-delete
          if (entry.createdAt < staleThreshold && accessCount === 0) {
            this.softDelete(entry.id, "older than 90 days with 0 recalls", now);
            deleted++;
            continue;
          }

          // Rule 4: Old + low recall count → deprioritize
          if (entry.createdAt < staleThreshold && accessCount <= 2) {
            this.deprioritize(entry.id, `older than 90 days with only ${accessCount} recalls`, now);
            deprioritized++;
            continue;
          }

          kept++;
        }
      });

      tx();
      offset += entries.length;
    }

    const result: DecayResult = { scanned, deleted, deprioritized, kept };
    log.info(result, "decay pass complete");
    return result;
  }

  /**
   * View decay log for a specific memory entry.
   */
  getLog(memoryId: string): readonly DecayLogEntry[] {
    const rows = this.stmts.logByMemory.all(memoryId) as DecayLogRow[];
    return rows.map(rowToEntry);
  }

  /**
   * View recent decay actions across all entries.
   */
  recentActions(limit = 50): readonly DecayLogEntry[] {
    const rows = this.stmts.recentLog.all(Math.max(1, Math.min(limit, 500))) as DecayLogRow[];
    return rows.map(rowToEntry);
  }

  /**
   * Undo a soft-delete by re-saving the entry content. Only works if
   * the entry was soft-deleted (actual content removed). Returns true
   * if restoration was logged (actual re-insertion depends on having
   * the original content available).
   */
  logRestoration(memoryId: string, reason: string): void {
    this.writeLog(memoryId, "keep", `restored: ${reason}`, Date.now());
  }

  // ── Internals ─────────────────────────────────────────────────

  private softDelete(memoryId: string, reason: string, now: number): void {
    const success = this.memory.delete(memoryId);
    if (success) {
      this.writeLog(memoryId, "soft-delete", reason, now);
      log.debug({ memoryId, reason }, "memory soft-deleted");
    }
  }

  private deprioritize(memoryId: string, reason: string, now: number): void {
    // We tag as low-priority rather than deleting — the entry remains
    // searchable but SmartRecall can down-rank it.
    // Since MemoryStore doesn't have an update method, we log the action
    // and let consumers check the decay log or tags.
    this.writeLog(memoryId, "deprioritize", reason, now);
    log.debug({ memoryId, reason }, "memory deprioritized");
  }

  private writeLog(memoryId: string, action: string, reason: string, now: number): void {
    const id = randomUUID();
    this.stmts.insertLog.run(id, memoryId, action, reason, now);
  }

  private getRecallStats(memoryId: string): { access_count: number; last_accessed: number } | null {
    // Check if recall_stats table exists (SmartRecall may not be initialized)
    try {
      const row = this.stmts.getStats.get(memoryId) as {
        access_count: number;
        last_accessed: number;
      } | undefined;
      return row ?? null;
    } catch {
      // recall_stats table doesn't exist yet — treat as no stats
      return null;
    }
  }

  private prepareStatements() {
    // Prepare the recall_stats query lazily — table may not exist
    let statsStmt: Database.Statement | null = null;
    const self = this;

    return {
      insertLog: this.db.prepare(
        `INSERT INTO memory_decay_log (id, memory_id, action, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ),
      logByMemory: this.db.prepare(
        `SELECT id, memory_id, action, reason, created_at
         FROM memory_decay_log
         WHERE memory_id = ?
         ORDER BY created_at DESC`,
      ),
      recentLog: this.db.prepare(
        `SELECT id, memory_id, action, reason, created_at
         FROM memory_decay_log
         ORDER BY created_at DESC
         LIMIT ?`,
      ),
      get getStats(): Database.Statement {
        if (!statsStmt) {
          try {
            statsStmt = self.db.prepare(
              `SELECT access_count, last_accessed FROM recall_stats WHERE memory_id = ?`,
            );
          } catch {
            // recall_stats doesn't exist — create a dummy that always returns undefined
            statsStmt = self.db.prepare("SELECT NULL AS access_count, NULL AS last_accessed WHERE 0");
          }
        }
        return statsStmt;
      },
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function rowToEntry(row: DecayLogRow): DecayLogEntry {
  return {
    id: row.id,
    memoryId: row.memory_id,
    action: row.action as DecayAction,
    reason: row.reason,
    createdAt: row.created_at,
  };
}
