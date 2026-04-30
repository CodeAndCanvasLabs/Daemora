/**
 * SessionStore — persists chat sessions + their message history in SQLite.
 *
 * The store is deliberately thin: it writes ModelMessage values straight to
 * a JSON column and reads them back in `seq` order, so the AI SDK sees
 * exactly what it wrote. No intermediate shape, no drift when the SDK adds
 * a new content-part kind (tool_call, tool_result, reasoning, ...).
 *
 * Hermes-parity additions:
 *   - `parent_session_id` for compression / delegation lineage.
 *   - `source` + `user_id` + `system_prompt` columns on sessions.
 *   - `token_count` per message (caller-supplied estimate).
 *   - FTS5 virtual table (`session_messages_fts`) for cross-session
 *     keyword recall, with insert/update/delete triggers keeping it in sync.
 *
 * Summarisation (compaction) lives in `src/core/Compaction.ts`.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ModelMessage } from "ai";

import { createLogger } from "../util/logger.js";

const log = createLogger("memory.session");

export interface SessionRow {
  readonly id: string;
  readonly title: string;
  readonly modelHint: string | null;
  readonly parentSessionId: string | null;
  readonly source: string | null;
  readonly userId: string | null;
  readonly systemPrompt: string | null;
  readonly totalTokens: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SessionSummary extends SessionRow {
  readonly messageCount: number;
}

export interface AppendedMessage {
  readonly id: string;
  readonly seq: number;
}

export interface MessageRow {
  readonly id: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly role: string;
  readonly contentJson: string;
  readonly tokenCount: number;
  readonly createdAt: number;
  /** Serialized AttachmentMeta[] — present only on user messages that
   *  came in with files. Read-only sidecar; model prompt is unaffected. */
  readonly attachmentsJson: string | null;
}

/**
 * Metadata about a file sent alongside a user message. Stored in the
 * `session_messages.attachments_json` sidecar column so the UI can
 * re-render image previews / file chips on history hydration. Paths
 * point at the materialized copy in `<dataDir>/inbox/`.
 */
export interface AttachmentMeta {
  readonly kind: "image" | "audio" | "video" | "document" | "file";
  readonly path: string;
  readonly mimeType: string;
  readonly filename?: string;
  readonly size?: number;
}

export interface SearchHit {
  readonly sessionId: string;
  readonly messageId: string;
  readonly seq: number;
  readonly role: string;
  readonly snippet: string;
  readonly createdAt: number;
  /** FTS5 rank (lower is better — raw bm25 output). */
  readonly rank: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  model_hint         TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  role          TEXT NOT NULL,
  content_json  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS session_messages_by_session
  ON session_messages (session_id, seq);

CREATE INDEX IF NOT EXISTS sessions_by_updated_at
  ON sessions (updated_at DESC);
`;

const SAFE_DEFAULT = 0;

/** Additive migrations — each must be idempotent and fail soft. */
function applyMigrations(db: Database.Database): void {
  const haveColumn = (table: string, col: string): boolean => {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.some((r) => r.name === col);
  };

  if (!haveColumn("sessions", "parent_session_id")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN parent_session_id TEXT`);
  }
  if (!haveColumn("sessions", "source")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN source TEXT`);
  }
  if (!haveColumn("sessions", "user_id")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN user_id TEXT`);
  }
  if (!haveColumn("sessions", "system_prompt")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN system_prompt TEXT`);
  }
  if (!haveColumn("sessions", "total_tokens")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT ${SAFE_DEFAULT}`);
  }
  if (!haveColumn("session_messages", "token_count")) {
    db.exec(`ALTER TABLE session_messages ADD COLUMN token_count INTEGER NOT NULL DEFAULT ${SAFE_DEFAULT}`);
  }
  if (!haveColumn("session_messages", "attachments_json")) {
    db.exec(`ALTER TABLE session_messages ADD COLUMN attachments_json TEXT`);
  }

  // FTS5 virtual table + triggers. Contentless FTS5 pointed at session_messages.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5 (
      content_text,
      content='',
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);

  // We can't use content=session_messages directly because content_json is JSON,
  // not plain text. Instead, triggers extract plain text and insert into FTS.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS session_messages_fts_ai AFTER INSERT ON session_messages
    BEGIN
      INSERT INTO session_messages_fts(rowid, content_text)
      VALUES (new.rowid, new.content_json);
    END;
    CREATE TRIGGER IF NOT EXISTS session_messages_fts_ad AFTER DELETE ON session_messages
    BEGIN
      INSERT INTO session_messages_fts(session_messages_fts, rowid, content_text)
      VALUES ('delete', old.rowid, old.content_json);
    END;
    CREATE TRIGGER IF NOT EXISTS session_messages_fts_au AFTER UPDATE ON session_messages
    BEGIN
      INSERT INTO session_messages_fts(session_messages_fts, rowid, content_text)
      VALUES ('delete', old.rowid, old.content_json);
      INSERT INTO session_messages_fts(rowid, content_text)
      VALUES (new.rowid, new.content_json);
    END;
  `);
}

/** Safe default. Callers can override via getHistory({ limit }). */
const DEFAULT_HISTORY_LIMIT = 40;

/**
 * A user message waiting to be merged into a session's history at the next
 * safe boundary (between AgentLoop streamText calls). In-memory only; lost
 * across process restarts (acceptable: client can resend).
 *
 * NEVER write to `session_messages` directly while a turn is active —
 * appending a `user` row between an `assistant{tool_calls}` and its
 * `tool` results would corrupt the LLM contract.
 */
export interface PendingInput {
  readonly text: string;
  readonly source: "chat" | "cron" | "channel" | "webhook" | "voice";
  readonly enqueuedAt: number;
}

export class SessionStore {
  private readonly insertSession: Database.Statement;
  private readonly selectSession: Database.Statement;
  private readonly listSessionsStmt: Database.Statement;
  private readonly deleteSessionStmt: Database.Statement;
  private readonly updateSessionTitle: Database.Statement;
  private readonly touchSession: Database.Statement;
  private readonly insertMessage: Database.Statement;
  private readonly selectHistory: Database.Statement;
  private readonly selectMessagesFull: Database.Statement;
  private readonly nextSeq: Database.Statement;
  private readonly incrementTokens: Database.Statement;
  private readonly ftsSearch: Database.Statement;
  private readonly getMessageById: Database.Statement;

  /**
   * Per-session inbox of user messages that arrived while a loop was
   * running. AgentLoop drains this at the top of every iteration (which
   * is the only "settled" point in the message stream — the previous
   * iteration's assistant + tool messages are fully persisted).
   */
  private readonly pending = new Map<string, PendingInput[]>();

  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);
    applyMigrations(db);

    this.insertSession = db.prepare(
      `INSERT INTO sessions
         (id, title, model_hint, parent_session_id, source, user_id, system_prompt, total_tokens, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    );
    this.selectSession = db.prepare(
      `SELECT id, title, model_hint AS modelHint,
              parent_session_id AS parentSessionId,
              source, user_id AS userId, system_prompt AS systemPrompt,
              total_tokens AS totalTokens,
              created_at AS createdAt, updated_at AS updatedAt
       FROM sessions WHERE id = ?`,
    );
    this.listSessionsStmt = db.prepare(
      `SELECT s.id, s.title, s.model_hint AS modelHint,
              s.parent_session_id AS parentSessionId,
              s.source, s.user_id AS userId, s.system_prompt AS systemPrompt,
              s.total_tokens AS totalTokens,
              s.created_at AS createdAt, s.updated_at AS updatedAt,
              COUNT(m.id) AS messageCount
       FROM sessions s
       LEFT JOIN session_messages m ON m.session_id = s.id
       GROUP BY s.id
       ORDER BY s.updated_at DESC
       LIMIT ? OFFSET ?`,
    );
    this.deleteSessionStmt = db.prepare(`DELETE FROM sessions WHERE id = ?`);
    this.updateSessionTitle = db.prepare(
      `UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`,
    );
    this.touchSession = db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`);
    this.insertMessage = db.prepare(
      `INSERT INTO session_messages (id, session_id, seq, role, content_json, token_count, created_at, attachments_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.selectHistory = db.prepare(
      `SELECT content_json FROM (
         SELECT content_json, seq
         FROM session_messages
         WHERE session_id = ?
         ORDER BY seq DESC
         LIMIT ?
       ) ORDER BY seq ASC`,
    );
    this.selectMessagesFull = db.prepare(
      `SELECT id, session_id AS sessionId, seq, role, content_json AS contentJson,
              token_count AS tokenCount, created_at AS createdAt,
              attachments_json AS attachmentsJson
       FROM session_messages
       WHERE session_id = ?
       ORDER BY seq ASC`,
    );
    this.nextSeq = db.prepare(
      `SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM session_messages WHERE session_id = ?`,
    );
    this.incrementTokens = db.prepare(
      `UPDATE sessions SET total_tokens = total_tokens + ? WHERE id = ?`,
    );
    this.ftsSearch = db.prepare(
      `SELECT m.id AS messageId, m.session_id AS sessionId, m.seq, m.role,
              snippet(session_messages_fts, 0, '[', ']', '…', 32) AS snippet,
              m.created_at AS createdAt,
              bm25(session_messages_fts) AS rank
       FROM session_messages_fts
       JOIN session_messages m ON m.rowid = session_messages_fts.rowid
       WHERE session_messages_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    );
    this.getMessageById = db.prepare(
      `SELECT id, session_id AS sessionId, seq, role, content_json AS contentJson,
              token_count AS tokenCount, created_at AS createdAt,
              attachments_json AS attachmentsJson
       FROM session_messages WHERE id = ?`,
    );
  }

  createSession(opts: {
    title?: string; modelHint?: string;
    parentSessionId?: string; source?: string; userId?: string;
    systemPrompt?: string;
  } = {}): SessionRow {
    return this.createSessionWithId(randomUUID(), opts);
  }

  createSessionWithId(id: string, opts: {
    title?: string; modelHint?: string;
    parentSessionId?: string; source?: string; userId?: string;
    systemPrompt?: string;
  } = {}): SessionRow {
    const now = Date.now();
    const title = (opts.title ?? "New chat").slice(0, 200);
    this.insertSession.run(
      id, title, opts.modelHint ?? null,
      opts.parentSessionId ?? null, opts.source ?? null, opts.userId ?? null,
      opts.systemPrompt ?? null, now, now,
    );
    log.debug({ sessionId: id, title, parent: opts.parentSessionId }, "session created");
    return {
      id, title, modelHint: opts.modelHint ?? null,
      parentSessionId: opts.parentSessionId ?? null,
      source: opts.source ?? null, userId: opts.userId ?? null,
      systemPrompt: opts.systemPrompt ?? null,
      totalTokens: 0, createdAt: now, updatedAt: now,
    };
  }

  /**
   * Create a child session linked to `parentId` — used by compaction
   * to start a new session holding the summary + protected tail.
   */
  createChildSession(parentId: string, opts: {
    title?: string; modelHint?: string; source?: string; userId?: string;
    systemPrompt?: string;
  } = {}): SessionRow {
    return this.createSession({ ...opts, parentSessionId: parentId });
  }

  getSession(id: string): SessionRow | null {
    const row = this.selectSession.get(id) as SessionRow | undefined;
    return row ?? null;
  }

  /**
   * Look up the most recent session matching a `source` tag and
   * (optionally) a parent session. Used by sub-agent runners to reuse
   * the same session across server restarts instead of orphaning a new
   * row every time — source is a stable key (e.g. `crew:<crewId>`).
   */
  findLatestSessionBySource(source: string, parentSessionId?: string): SessionRow | null {
    const where = parentSessionId
      ? `source = ? AND parent_session_id = ?`
      : `source = ?`;
    const params = parentSessionId ? [source, parentSessionId] : [source];
    const row = this.db.prepare(
      `SELECT id, title, model_hint AS modelHint,
              parent_session_id AS parentSessionId,
              source, user_id AS userId, system_prompt AS systemPrompt,
              total_tokens AS totalTokens,
              created_at AS createdAt, updated_at AS updatedAt
       FROM sessions
       WHERE ${where}
       ORDER BY updated_at DESC
       LIMIT 1`,
    ).get(...params) as SessionRow | undefined;
    return row ?? null;
  }

  listSessions(opts: { limit?: number; offset?: number } = {}): readonly SessionSummary[] {
    const limit = Math.min(opts.limit ?? 50, 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    return this.listSessionsStmt.all(limit, offset) as SessionSummary[];
  }

  deleteSession(id: string): boolean {
    const res = this.deleteSessionStmt.run(id);
    return res.changes > 0;
  }

  renameSession(id: string, title: string): boolean {
    const clean = title.trim().slice(0, 200);
    if (!clean) return false;
    const res = this.updateSessionTitle.run(clean, Date.now(), id);
    return res.changes > 0;
  }

  /**
   * Append one ModelMessage to the session. Auto-sequences under a
   * row-level lock by computing nextSeq + insert inside a transaction
   * so two concurrent appenders can't collide on (session_id, seq).
   *
   * `tokenCount` is caller-supplied (estimates are fine — the column
   * is advisory, used by compaction to decide when to trigger).
   */
  appendMessage(
    sessionId: string,
    message: ModelMessage,
    tokenCount = 0,
    opts: { attachments?: readonly AttachmentMeta[] } = {},
  ): AppendedMessage {
    const id = randomUUID();
    const now = Date.now();
    const json = JSON.stringify(message);
    const attachmentsJson = opts.attachments && opts.attachments.length > 0
      ? JSON.stringify(opts.attachments)
      : null;
    const run = this.db.transaction((): AppendedMessage => {
      const next = this.nextSeq.get(sessionId) as { next: number } | undefined;
      const seq = next?.next ?? 0;
      this.insertMessage.run(id, sessionId, seq, message.role, json, tokenCount, now, attachmentsJson);
      this.touchSession.run(now, sessionId);
      if (tokenCount > 0) this.incrementTokens.run(tokenCount, sessionId);
      return { id, seq };
    });
    return run();
  }

  /**
   * Same slice as `getHistory` (most-recent-N, oldest-first) but returns
   * full MessageRow objects so the UI can read attachment metadata.
   */
  getHistoryRows(sessionId: string, opts: { limit?: number } = {}): readonly MessageRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_HISTORY_LIMIT, 500));
    const rows = this.db.prepare(
      `SELECT id, session_id AS sessionId, seq, role, content_json AS contentJson,
              token_count AS tokenCount, created_at AS createdAt,
              attachments_json AS attachmentsJson
       FROM (
         SELECT id, session_id, seq, role, content_json, token_count, created_at, attachments_json
         FROM session_messages
         WHERE session_id = ?
         ORDER BY seq DESC
         LIMIT ?
       )
       ORDER BY seq ASC`,
    ).all(sessionId, limit) as MessageRow[];
    return rows;
  }

  /**
   * Most-recent N messages, returned oldest-first, ready to splice in
   * front of the next user turn.
   */
  getHistory(sessionId: string, opts: { limit?: number } = {}): ModelMessage[] {
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_HISTORY_LIMIT, 500));
    const rows = this.selectHistory.all(sessionId, limit) as { content_json: string }[];
    return rows.map((r) => JSON.parse(r.content_json) as ModelMessage);
  }

  // ── Pending input queue ─────────────────────────────────────────────────
  // In-memory inbox for user messages that arrive while a loop is busy.
  // Drained by AgentLoop at the top of every iteration (the safe boundary
  // — see the type doc above for why mid-iteration appends are unsafe).

  /** Append a user message to the per-session pending inbox. */
  enqueuePending(sessionId: string, input: PendingInput): void {
    const list = this.pending.get(sessionId);
    if (list) list.push(input);
    else this.pending.set(sessionId, [input]);
  }

  /** True iff there is at least one pending input for the session. */
  hasPending(sessionId: string): boolean {
    const list = this.pending.get(sessionId);
    return !!list && list.length > 0;
  }

  /**
   * Remove and return all pending inputs for the session. Caller is
   * responsible for converting them into ModelMessages and persisting
   * via `appendMessage` only at a safe boundary.
   */
  drainPending(sessionId: string): readonly PendingInput[] {
    const list = this.pending.get(sessionId);
    if (!list || list.length === 0) return [];
    this.pending.delete(sessionId);
    return list;
  }

  /** Full message list (no cap) — used by compaction + session_search. */
  getMessagesFull(sessionId: string): readonly MessageRow[] {
    return this.selectMessagesFull.all(sessionId) as MessageRow[];
  }

  /**
   * Return the full conversation as ModelMessage list. Used by
   * session_search to format a transcript for cheap-model summarization.
   */
  getMessagesAsConversation(sessionId: string): readonly ModelMessage[] {
    return this.getMessagesFull(sessionId).map(
      (r) => JSON.parse(r.contentJson) as ModelMessage,
    );
  }

  /**
   * Walk the parent chain to the root session. Stops at the first
   * session without a parent. Used by session_search to dedupe child
   * (compacted / delegated) sessions back to the user-visible root.
   */
  resolveToParent(sessionId: string): string {
    const seen = new Set<string>();
    let current = sessionId;
    while (!seen.has(current)) {
      seen.add(current);
      const row = this.getSession(current);
      if (!row || !row.parentSessionId) return current;
      current = row.parentSessionId;
    }
    return current;
  }

  /** FTS5 BM25 search across all session messages. */
  searchMessages(query: string, opts: { limit?: number } = {}): readonly SearchHit[] {
    const q = sanitiseFtsQuery(query);
    if (!q) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const rows = this.ftsSearch.all(q, limit) as Array<{
      messageId: string; sessionId: string; seq: number; role: string;
      snippet: string; createdAt: number; rank: number;
    }>;
    return rows;
  }

  /** Get a single message row. */
  getMessage(id: string): MessageRow | null {
    const row = this.getMessageById.get(id) as MessageRow | undefined;
    return row ?? null;
  }
}

/**
 * FTS5 has its own query syntax. Escape each token individually and OR
 * them together — that gives "hit if any of these words match" which
 * matches user intuition for recall.
 */
function sanitiseFtsQuery(raw: string): string {
  const cleaned = raw
    .split(/\s+/)
    .map((t) => t.replace(/["'`]/g, "").trim())
    .filter((t) => t.length > 0 && /[\p{L}\p{N}]/u.test(t));
  if (cleaned.length === 0) return "";
  return cleaned.map((t) => `"${t}"`).join(" OR ");
}
