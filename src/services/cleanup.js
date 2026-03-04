/**
 * cleanup.js - Data retention management.
 *
 * Cleans up old task files, audit logs, cost logs, and stale sub-agent sessions.
 * Configurable via CLEANUP_AFTER_DAYS env var (default: 30, 0 = never delete).
 */
import { readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/default.js";

const CLEANUP_DAYS = parseInt(process.env.CLEANUP_AFTER_DAYS || "30", 10);

/**
 * Run cleanup across all data directories.
 * @param {number} [days] - Override retention days (0 = skip)
 * @returns {{ tasks: number, audit: number, costs: number, sessions: number, total: number }}
 */
export function runCleanup(days = CLEANUP_DAYS) {
  if (days <= 0) return { tasks: 0, audit: 0, costs: 0, sessions: 0, total: 0 };

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const results = {
    tasks: cleanDir(config.tasksDir, cutoff, ".json"),
    audit: cleanDir(config.auditDir, cutoff, ".jsonl"),
    costs: cleanDir(config.costsDir, cutoff, ".jsonl"),
    sessions: cleanStaleSessions(cutoff),
    total: 0,
  };
  results.total = results.tasks + results.audit + results.costs + results.sessions;
  return results;
}

/**
 * Delete files older than cutoff in a directory.
 */
function cleanDir(dirPath, cutoffMs, ext) {
  if (!existsSync(dirPath)) return 0;
  let deleted = 0;
  try {
    const files = readdirSync(dirPath).filter(f => f.endsWith(ext));
    for (const file of files) {
      const filePath = join(dirPath, file);
      try {
        const mtime = statSync(filePath).mtimeMs;
        if (mtime < cutoffMs) {
          unlinkSync(filePath);
          deleted++;
        }
      } catch {}
    }
  } catch {}
  return deleted;
}

/**
 * Clean sub-agent sessions (telegram-123--coder.json) that are stale.
 * Main user sessions (no "--") are kept regardless.
 */
function cleanStaleSessions(cutoffMs) {
  if (!existsSync(config.sessionsDir)) return 0;
  let deleted = 0;
  try {
    const files = readdirSync(config.sessionsDir).filter(f => f.endsWith(".json"));
    for (const file of files) {
      const name = file.slice(0, -5);
      // Only clean sub-agent sessions (contain "--")
      if (!name.includes("--")) continue;
      const filePath = join(config.sessionsDir, file);
      try {
        const mtime = statSync(filePath).mtimeMs;
        if (mtime < cutoffMs) {
          unlinkSync(filePath);
          deleted++;
        }
      } catch {}
    }
  } catch {}
  return deleted;
}

/**
 * Get storage stats without deleting anything.
 */
export function getStorageStats() {
  return {
    tasks: countDir(config.tasksDir, ".json"),
    audit: countDir(config.auditDir, ".jsonl"),
    costs: countDir(config.costsDir, ".jsonl"),
    sessions: countDir(config.sessionsDir, ".json"),
    retentionDays: CLEANUP_DAYS || "never",
  };
}

function countDir(dirPath, ext) {
  if (!existsSync(dirPath)) return { files: 0, sizeKB: 0 };
  try {
    const files = readdirSync(dirPath).filter(f => f.endsWith(ext));
    let totalSize = 0;
    for (const file of files) {
      try { totalSize += statSync(join(dirPath, file)).size; } catch {}
    }
    return { files: files.length, sizeKB: Math.round(totalSize / 1024) };
  } catch {
    return { files: 0, sizeKB: 0 };
  }
}
