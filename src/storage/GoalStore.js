/**
 * GoalStore - SQLite persistence for autonomous goals.
 *
 * Table: goals (created in Database.js migration).
 * Follows CronStore.js pattern: pure functions, import DB helpers.
 */
import { queryAll, queryOne, run } from "../storage/Database.js";

// ── Goals ─────────────────────────────────────────────────────────────────────

export function saveGoal(goal) {
  run(
    `INSERT INTO goals (
      id, tenant_id, title, description, strategy,
      status, priority, check_cron, check_tz,
      last_check_at, last_result, next_check_at,
      consecutive_failures, max_failures, delivery,
      created_at, updated_at
    ) VALUES (
      $id, $tenantId, $title, $desc, $strategy,
      $status, $priority, $checkCron, $checkTz,
      $lastCheckAt, $lastResult, $nextCheckAt,
      $consFailures, $maxFailures, $delivery,
      $createdAt, $updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      tenant_id=$tenantId, title=$title, description=$desc, strategy=$strategy,
      status=$status, priority=$priority, check_cron=$checkCron, check_tz=$checkTz,
      last_check_at=$lastCheckAt, last_result=$lastResult, next_check_at=$nextCheckAt,
      consecutive_failures=$consFailures, max_failures=$maxFailures, delivery=$delivery,
      updated_at=$updatedAt`,
    {
      $id: goal.id,
      $tenantId: goal.tenantId || null,
      $title: goal.title,
      $desc: goal.description || null,
      $strategy: goal.strategy || null,
      $status: goal.status || "active",
      $priority: goal.priority ?? 5,
      $checkCron: goal.checkCron || "0 */4 * * *",
      $checkTz: goal.checkTz || null,
      $lastCheckAt: goal.lastCheckAt || null,
      $lastResult: goal.lastResult || null,
      $nextCheckAt: goal.nextCheckAt || null,
      $consFailures: goal.consecutiveFailures ?? 0,
      $maxFailures: goal.maxFailures ?? 3,
      $delivery: goal.delivery ? JSON.stringify(goal.delivery) : null,
      $createdAt: goal.createdAt || new Date().toISOString(),
      $updatedAt: goal.updatedAt || new Date().toISOString(),
    }
  );
}

export function loadGoal(id) {
  const row = queryOne("SELECT * FROM goals WHERE id = $id", { $id: id });
  return row ? _rowToGoal(row) : null;
}

export function loadGoalsByTenant(tenantId) {
  return queryAll(
    "SELECT * FROM goals WHERE tenant_id = $tid ORDER BY priority DESC",
    { $tid: tenantId }
  ).map(_rowToGoal);
}

export function loadActiveGoals() {
  return queryAll(
    "SELECT * FROM goals WHERE status = 'active' ORDER BY next_check_at ASC"
  ).map(_rowToGoal);
}

export function loadDueGoals() {
  return queryAll(
    "SELECT * FROM goals WHERE status = 'active' AND next_check_at <= datetime('now') ORDER BY next_check_at ASC"
  ).map(_rowToGoal);
}

export function deleteGoal(id) {
  run("DELETE FROM goals WHERE id = $id", { $id: id });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _rowToGoal(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    title: row.title,
    description: row.description,
    strategy: row.strategy,
    status: row.status,
    priority: row.priority ?? 5,
    checkCron: row.check_cron || "0 */4 * * *",
    checkTz: row.check_tz,
    lastCheckAt: row.last_check_at,
    lastResult: row.last_result,
    nextCheckAt: row.next_check_at,
    consecutiveFailures: row.consecutive_failures ?? 0,
    maxFailures: row.max_failures ?? 3,
    delivery: row.delivery ? JSON.parse(row.delivery) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
