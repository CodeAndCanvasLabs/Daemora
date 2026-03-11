import { queryAll, queryOne, run } from "./Database.js";

/**
 * Save a task (insert or update).
 */
export function saveTask(task) {
  const ts = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, tenant_id, channel, session_id, type, title, description, status, priority,
     parent_task_id, agent_id, agent_created, input, result, error,
     created_at, started_at, completed_at, updated_at)
     VALUES ($id, $tenant_id, $channel, $session_id, $type, $title, $desc, $status, $priority,
     $parent, $agent_id, $agent_created, $input, $result, $error,
     $created_at, $started_at, $completed_at, $updated_at)
     ON CONFLICT(id) DO UPDATE SET
       tenant_id = excluded.tenant_id,
       channel = excluded.channel,
       session_id = excluded.session_id,
       type = excluded.type,
       title = excluded.title,
       description = excluded.description,
       status = excluded.status,
       priority = excluded.priority,
       parent_task_id = excluded.parent_task_id,
       agent_id = excluded.agent_id,
       agent_created = excluded.agent_created,
       input = excluded.input,
       result = excluded.result,
       error = excluded.error,
       started_at = excluded.started_at,
       completed_at = excluded.completed_at,
       updated_at = excluded.updated_at`,
    {
      $id: task.id,
      $tenant_id: task.tenantId || null,
      $channel: task.channel || null,
      $session_id: task.sessionId || null,
      $type: task.type || "chat",
      $title: task.title || null,
      $desc: task.description || null,
      $status: task.status || "pending",
      $priority: task.priority || "normal",
      $parent: task.parentTaskId || null,
      $agent_id: task.agentId || null,
      $agent_created: task.agentCreated ? 1 : 0,
      $input: task.input ? (typeof task.input === "string" ? task.input : JSON.stringify(task.input)) : null,
      $result: task.result ? (typeof task.result === "string" ? task.result : JSON.stringify(task.result)) : null,
      $error: task.error || null,
      $created_at: task.createdAt || ts,
      $started_at: task.startedAt || null,
      $completed_at: task.completedAt || null,
      $updated_at: ts,
    }
  );
}

/**
 * Load a task by ID.
 */
export function loadTask(taskId) {
  const row = queryOne("SELECT * FROM tasks WHERE id = $id", { $id: taskId });
  return row ? _rowToTask(row) : null;
}

/**
 * List recent tasks (sorted by createdAt descending).
 */
export function listTasks({ limit = 20, status = null, type = null } = {}) {
  let sql = "SELECT * FROM tasks WHERE 1=1";
  const params = {};

  if (status) {
    sql += " AND status = $status";
    params.$status = status;
  }
  if (type) {
    sql += " AND type = $type";
    params.$type = type;
  }

  sql += " ORDER BY created_at DESC LIMIT $limit";
  params.$limit = limit;

  return queryAll(sql, params).map(_rowToTask);
}

/**
 * List child tasks of a given parent task.
 */
export function listChildTasks(parentTaskId) {
  return queryAll(
    "SELECT * FROM tasks WHERE parent_task_id = $pid ORDER BY created_at ASC",
    { $pid: parentTaskId }
  ).map(_rowToTask);
}

/**
 * On startup, find tasks stuck in "running" state and reset to "pending".
 */
export function recoverStaleTasks() {
  const stale = queryAll("SELECT id FROM tasks WHERE status = 'running'");
  for (const row of stale) {
    run(
      "UPDATE tasks SET status = 'pending', started_at = NULL, updated_at = $ts WHERE id = $id",
      { $id: row.id, $ts: new Date().toISOString() }
    );
    console.log(`[TaskStore] Recovered stale task: ${row.id}`);
  }
  return stale.length;
}

/**
 * Load pending tasks for recovery on startup.
 * Only recovers agent-created tasks (background work) — not user chat tasks.
 * User chat sessions are one-shot and replaying them after restart creates duplicates.
 */
export function loadPendingTasks() {
  return queryAll(
    "SELECT * FROM tasks WHERE status = 'pending' AND agent_created = 1 ORDER BY priority ASC, created_at ASC"
  ).map(_rowToTask);
}

function _rowToTask(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    channel: row.channel || undefined,
    sessionId: row.session_id || undefined,
    type: row.type || "chat",
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority || "normal",
    parentTaskId: row.parent_task_id,
    agentId: row.agent_id,
    agentCreated: !!row.agent_created,
    input: _tryParse(row.input),
    result: _tryParse(row.result),
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function _tryParse(val) {
  if (val == null) return val;
  try {
    const parsed = JSON.parse(val);
    if (typeof parsed === "object") return parsed;
    return val;
  } catch {
    return val;
  }
}
