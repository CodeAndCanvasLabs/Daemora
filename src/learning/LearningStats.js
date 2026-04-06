/**
 * Learning observability — track what was extracted, what actions were taken.
 * In-memory counters + persistent log in SQLite learning_log table.
 */
import { run, queryAll, queryOne } from "../storage/Database.js";

const _stats = {
  extraction_attempts: 0,
  facts_extracted: 0,
  memories_added: 0,
  memories_updated: 0,
  memories_superseded: 0,
  skills_created: 0,
  errors: 0,
};

export function incrementStats(key, count = 1) {
  if (key in _stats) _stats[key] += count;
}

export function getStats() {
  return { ..._stats };
}

export function logLearning(taskId, type, action, details = {}) {
  try {
    run(
      `INSERT INTO learning_log (task_id, type, action, memory_id, details, model, tokens_in, tokens_out, latency_ms)
       VALUES ($taskId, $type, $action, $memId, $details, $model, $tokIn, $tokOut, $latMs)`,
      {
        $taskId: taskId || null,
        $type: type,
        $action: action,
        $memId: details.memoryId || null,
        $details: JSON.stringify(details),
        $model: details.modelId || null,
        $tokIn: details.inputTokens || null,
        $tokOut: details.outputTokens || null,
        $latMs: details.latencyMs || null,
      }
    );
  } catch {
    // Non-fatal — never crash the learning pipeline for logging
  }
}

export function getLearningReport(days = 7) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return queryAll(
    `SELECT type, action, COUNT(*) as count
     FROM learning_log WHERE created_at >= $cutoff
     GROUP BY type, action ORDER BY count DESC`,
    { $cutoff: cutoff }
  );
}

export function getRecentLearnings(limit = 20) {
  return queryAll(
    "SELECT * FROM learning_log ORDER BY id DESC LIMIT $limit",
    { $limit: limit }
  );
}
