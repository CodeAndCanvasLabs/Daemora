/**
 * TaskStore — persists agent task execution history for the Logs page.
 *
 * Every POST /api/chat creates a task. When the task completes or
 * fails, it's recorded here with timing, model, token usage, and
 * the final result summary.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import { createLogger } from "../util/logger.js";

const log = createLogger("tasks");

export interface TaskRow {
  readonly id: string;
  readonly sessionId: string;
  readonly input: string;
  readonly model: string | null;
  readonly status: "pending" | "running" | "completed" | "failed";
  readonly result: string | null;
  readonly error: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolCalls: number;
  readonly steps: number;
  readonly durationMs: number | null;
  readonly createdAt: number;
  readonly completedAt: number | null;
  readonly channel: string | null;
  readonly channelMeta: Record<string, unknown> | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS task_log (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  input          TEXT NOT NULL,
  model          TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  result         TEXT,
  error          TEXT,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  tool_calls     INTEGER NOT NULL DEFAULT 0,
  steps          INTEGER NOT NULL DEFAULT 0,
  duration_ms    INTEGER,
  created_at     INTEGER NOT NULL,
  completed_at   INTEGER,
  channel        TEXT,
  channel_meta   TEXT
);

CREATE INDEX IF NOT EXISTS task_log_by_created
  ON task_log (created_at DESC);

CREATE INDEX IF NOT EXISTS task_log_by_status
  ON task_log (status);

CREATE TABLE IF NOT EXISTS task_tool_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES task_log(id) ON DELETE CASCADE,
  tool_name   TEXT NOT NULL,
  args_json   TEXT,
  result_json TEXT,
  error       TEXT,
  duration_ms INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS task_tool_calls_by_task
  ON task_tool_calls (task_id);
`;

export interface ToolCallRecord {
  readonly id: number;
  readonly taskId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly result: unknown;
  readonly error: string | null;
  readonly durationMs: number | null;
  readonly createdAt: number;
}

export class TaskStore {
  private readonly insertStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;
  private readonly selectAll: Database.Statement;
  private readonly selectOne: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly insertToolCall: Database.Statement;
  private readonly selectToolCalls: Database.Statement;

  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);
    // Additive migration for pre-existing dbs.
    for (const stmt of [
      "ALTER TABLE task_log ADD COLUMN channel TEXT",
      "ALTER TABLE task_log ADD COLUMN channel_meta TEXT",
    ]) {
      try { db.exec(stmt); } catch { /* column already exists */ }
    }

    this.insertStmt = db.prepare(
      `INSERT INTO task_log (id, session_id, input, model, status, created_at, channel, channel_meta)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
    );
    this.updateStmt = db.prepare(
      `UPDATE task_log SET status=?, result=?, error=?, input_tokens=?, output_tokens=?,
              tool_calls=?, steps=?, duration_ms=?, completed_at=? WHERE id=?`,
    );
    this.selectAll = db.prepare(
      `SELECT id, session_id AS sessionId, input, model, status, result, error,
              input_tokens AS inputTokens, output_tokens AS outputTokens,
              tool_calls AS toolCalls, steps, duration_ms AS durationMs,
              created_at AS createdAt, completed_at AS completedAt,
              channel, channel_meta AS channelMetaJson
       FROM task_log ORDER BY created_at DESC LIMIT ?`,
    );
    this.selectOne = db.prepare(
      `SELECT id, session_id AS sessionId, input, model, status, result, error,
              input_tokens AS inputTokens, output_tokens AS outputTokens,
              tool_calls AS toolCalls, steps, duration_ms AS durationMs,
              created_at AS createdAt, completed_at AS completedAt,
              channel, channel_meta AS channelMetaJson
       FROM task_log WHERE id = ?`,
    );
    this.deleteStmt = db.prepare(`DELETE FROM task_log WHERE id = ?`);
    this.insertToolCall = db.prepare(
      `INSERT INTO task_tool_calls (task_id, tool_name, args_json, result_json, error, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.selectToolCalls = db.prepare(
      `SELECT id, task_id AS taskId, tool_name AS toolName, args_json AS argsJson,
              result_json AS resultJson, error, duration_ms AS durationMs, created_at AS createdAt
       FROM task_tool_calls WHERE task_id = ? ORDER BY created_at ASC`,
    );
  }

  create(
    id: string,
    sessionId: string,
    input: string,
    model?: string,
    channel?: string,
    channelMeta?: Record<string, unknown>,
  ): void {
    this.insertStmt.run(
      id,
      sessionId,
      input.slice(0, 500),
      model ?? null,
      Date.now(),
      channel ?? null,
      channelMeta ? JSON.stringify(channelMeta) : null,
    );
    log.debug({ taskId: id, channel }, "task created");
  }

  complete(id: string, opts: {
    result?: string;
    inputTokens?: number;
    outputTokens?: number;
    toolCalls?: number;
    steps?: number;
    durationMs?: number;
  }): void {
    this.updateStmt.run(
      "completed",
      opts.result?.slice(0, 2000) ?? null,
      null,
      opts.inputTokens ?? 0,
      opts.outputTokens ?? 0,
      opts.toolCalls ?? 0,
      opts.steps ?? 0,
      opts.durationMs ?? null,
      Date.now(),
      id,
    );
  }

  fail(id: string, error: string, durationMs?: number): void {
    this.updateStmt.run(
      "failed", null, error.slice(0, 1000),
      0, 0, 0, 0, durationMs ?? null, Date.now(), id,
    );
  }

  list(limit = 100): readonly TaskRow[] {
    const rows = this.selectAll.all(Math.min(limit, 500)) as (Omit<TaskRow, "channelMeta"> & { channelMetaJson: string | null })[];
    return rows.map(hydrateTaskRow);
  }

  /**
   * Failed tasks created after `sinceMs`, newest first, capped at `limit`.
   * Used by Heartbeat to surface recent failures worth retrying/surfacing.
   */
  recentFailed(sinceMs: number, limit = 10): readonly TaskRow[] {
    const rows = this.db.prepare(
      `SELECT id, session_id AS sessionId, input, model, status, result, error,
              input_tokens AS inputTokens, output_tokens AS outputTokens,
              tool_calls AS toolCalls, steps, duration_ms AS durationMs,
              created_at AS createdAt, completed_at AS completedAt,
              channel, channel_meta AS channelMetaJson
         FROM task_log
        WHERE status = 'failed' AND created_at > ?
        ORDER BY created_at DESC
        LIMIT ?`,
    ).all(sinceMs, Math.min(limit, 100)) as (Omit<TaskRow, "channelMeta"> & { channelMetaJson: string | null })[];
    return rows.map(hydrateTaskRow);
  }

  get(id: string): TaskRow | null {
    const row = this.selectOne.get(id) as (Omit<TaskRow, "channelMeta"> & { channelMetaJson: string | null }) | undefined;
    return row ? hydrateTaskRow(row) : null;
  }

  delete(id: string): boolean {
    return this.deleteStmt.run(id).changes > 0;
  }

  /** Record a tool call with its args and result. */
  recordToolCall(taskId: string, toolName: string, args?: unknown, result?: unknown, error?: string, durationMs?: number): void {
    const argsJson = safeStringify(args, 5000);
    const resultJson = safeStringify(result, 10000);
    this.insertToolCall.run(taskId, toolName, argsJson, resultJson, error ?? null, durationMs ?? null, Date.now());
  }

  /** Get all tool calls for a task. */
  getToolCalls(taskId: string): readonly ToolCallRecord[] {
    const rows = this.selectToolCalls.all(taskId) as {
      id: number; taskId: string; toolName: string;
      argsJson: string | null; resultJson: string | null;
      error: string | null; durationMs: number | null; createdAt: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      toolName: r.toolName,
      args: safeParse(r.argsJson),
      result: safeParse(r.resultJson),
      error: r.error,
      durationMs: r.durationMs,
      createdAt: r.createdAt,
    }));
  }
}

/**
 * Stringify with a hard size cap. If the encoded value exceeds `max`,
 * we wrap it as `{ _truncated: true, size, preview }` so the stored
 * blob is always valid JSON. A naive `.slice(0, N)` would land in the
 * middle of an escaped string and break `JSON.parse` on read.
 */
function safeStringify(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  let full: string;
  try { full = JSON.stringify(value); } catch { return null; }
  if (full.length <= max) return full;
  return JSON.stringify({ _truncated: true, size: full.length, preview: full.slice(0, Math.max(0, max - 200)) });
}

/**
 * Parse defensively. Old rows written before the truncation fix can
 * contain invalid JSON — surface them as a stub instead of throwing.
 */
function safeParse(json: string | null): unknown {
  if (!json) return null;
  try { return JSON.parse(json); }
  catch { return { _corrupt: true, length: json.length, preview: json.slice(0, 200) }; }
}

function hydrateTaskRow(row: Omit<TaskRow, "channelMeta"> & { channelMetaJson: string | null }): TaskRow {
  const { channelMetaJson, ...rest } = row;
  let channelMeta: Record<string, unknown> | null = null;
  if (channelMetaJson) {
    try { channelMeta = JSON.parse(channelMetaJson) as Record<string, unknown>; } catch { channelMeta = null; }
  }
  return { ...rest, channelMeta } as TaskRow;
}
