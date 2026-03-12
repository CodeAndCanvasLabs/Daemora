/**
 * cleanup.js - Data retention management.
 *
 * Cleans up old tasks, audit logs, cost entries, and stale sub-agent sessions from SQLite.
 * Configurable via CLEANUP_AFTER_DAYS env var (default: 30, 0 = never delete).
 */
import { queryOne, run } from "../storage/Database.js";

const CLEANUP_DAYS = parseInt(process.env.CLEANUP_AFTER_DAYS || "30", 10);

/**
 * Run cleanup across all SQLite tables.
 * @param {number} [days] - Override retention days (0 = skip)
 * @returns {{ tasks: number, audit: number, costs: number, sessions: number, total: number }}
 */
export function runCleanup(days = CLEANUP_DAYS) {
  if (days <= 0) return { tasks: 0, audit: 0, costs: 0, sessions: 0, total: 0 };

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const results = {
    tasks: _cleanTable("tasks", "created_at", cutoff),
    audit: _cleanTable("audit_log", "created_at", cutoff),
    costs: _cleanTable("cost_entries", "created_at", cutoff),
    sessions: _cleanStaleSessions(cutoff),
    total: 0,
  };
  results.total = results.tasks + results.audit + results.costs + results.sessions;
  return results;
}

/**
 * Delete rows older than cutoff in a table.
 */
function _cleanTable(table, dateCol, cutoff) {
  try {
    const result = run(`DELETE FROM ${table} WHERE ${dateCol} < $cutoff`, { $cutoff: cutoff });
    return result.changes;
  } catch {
    return 0;
  }
}

/**
 * Clean sub-agent sessions (IDs containing "--") that are stale.
 * Main user sessions (no "--") are kept regardless.
 */
function _cleanStaleSessions(cutoff) {
  try {
    // Delete messages first (FK cascade should handle it, but be explicit)
    run(
      `DELETE FROM messages WHERE session_id IN (
        SELECT id FROM sessions WHERE id LIKE '%---%' AND updated_at < $cutoff
      )`,
      { $cutoff: cutoff }
    );
    const result = run(
      "DELETE FROM sessions WHERE id LIKE '%---%' AND updated_at < $cutoff",
      { $cutoff: cutoff }
    );
    return result.changes;
  } catch {
    return 0;
  }
}

/**
 * Get storage stats without deleting anything.
 */
export function getStorageStats() {
  return {
    tasks: _countTable("tasks"),
    audit: _countTable("audit_log"),
    costs: _countTable("cost_entries"),
    sessions: _countTable("sessions"),
    retentionDays: CLEANUP_DAYS || "never",
  };
}

/**
 * Delete completed/failed/cancelled tasks (not pending or running).
 * @returns {number} Number of tasks deleted
 */
export function cleanCompletedTasks() {
  try {
    const result = run(
      "DELETE FROM tasks WHERE status IN ('completed', 'failed', 'cancelled')"
    );
    return result.changes;
  } catch {
    return 0;
  }
}

function _countTable(table) {
  try {
    const row = queryOne(`SELECT COUNT(*) as files FROM ${table}`);
    return { files: row.files, sizeKB: 0 }; // SQLite doesn't expose per-table size easily
  } catch {
    return { files: 0, sizeKB: 0 };
  }
}
