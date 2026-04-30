/**
 * MemoryStore — long-term keyword memory for the agent.
 *
 * What this is
 * ------------
 *   A pair of tools — `memory_save` and `memory_recall` — let the agent
 *   commit durable facts ("Zain's birthday is Oct 2", "we use pnpm, not
 *   npm") and retrieve them across conversations.
 *
 * What this isn't
 * ---------------
 *   - Not episodic chat history. That's SessionStore.
 *   - Not embeddings. Semantic recall is a separate tier that plugs in
 *     later without migrating this table (just add a column).
 *
 * Ranking — BM25 via SQLite FTS5. Good enough for "remember the thing
 * I told you last week" recall with no external dep.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import { createLogger } from "../util/logger.js";

const log = createLogger("memory.store");

export interface MemoryEntry {
  readonly id: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly source: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MemoryHit extends MemoryEntry {
  /** FTS5 rank (lower is better — raw BM25 output). */
  readonly rank: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_entries (
  id          TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  tags_json   TEXT NOT NULL DEFAULT '[]',
  source      TEXT NOT NULL DEFAULT 'agent',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS memory_entries_by_created
  ON memory_entries (created_at DESC);

-- Full-text search index — content + tags, tokenized with unicode61
-- (lowercases, strips diacritics, splits on non-alphanum).
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5 (
  content,
  tags,
  content='memory_entries',
  content_rowid='rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Keep FTS in sync via triggers. FTS rebuild is O(N); we only need
-- incremental maintenance here because entries are small + frequent.
CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory_entries BEGIN
  INSERT INTO memory_fts (rowid, content, tags)
  VALUES (new.rowid, new.content, new.tags_json);
END;
CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory_entries BEGIN
  INSERT INTO memory_fts (memory_fts, rowid, content, tags)
  VALUES ('delete', old.rowid, old.content, old.tags_json);
END;
CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory_entries BEGIN
  INSERT INTO memory_fts (memory_fts, rowid, content, tags)
  VALUES ('delete', old.rowid, old.content, old.tags_json);
  INSERT INTO memory_fts (rowid, content, tags)
  VALUES (new.rowid, new.content, new.tags_json);
END;
`;

export class MemoryStore {
  private readonly insertEntry: Database.Statement;
  private readonly selectOne: Database.Statement;
  private readonly deleteOne: Database.Statement;
  private readonly recall: Database.Statement;
  private readonly listRecent: Database.Statement;

  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);

    this.insertEntry = db.prepare(
      `INSERT INTO memory_entries (id, content, tags_json, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.selectOne = db.prepare(
      `SELECT id, content, tags_json AS tagsJson, source,
              created_at AS createdAt, updated_at AS updatedAt
       FROM memory_entries WHERE id = ?`,
    );
    this.deleteOne = db.prepare(`DELETE FROM memory_entries WHERE id = ?`);
    this.recall = db.prepare(
      `SELECT e.id, e.content, e.tags_json AS tagsJson, e.source,
              e.created_at AS createdAt, e.updated_at AS updatedAt,
              m.rank
       FROM memory_fts m
       JOIN memory_entries e ON e.rowid = m.rowid
       WHERE memory_fts MATCH ?
       ORDER BY m.rank
       LIMIT ?`,
    );
    this.listRecent = db.prepare(
      `SELECT id, content, tags_json AS tagsJson, source,
              created_at AS createdAt, updated_at AS updatedAt
       FROM memory_entries
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    );
  }

  save(opts: {
    content: string;
    tags?: readonly string[];
    source?: string;
  }): MemoryEntry {
    const id = randomUUID();
    const now = Date.now();
    const tags = Array.from(new Set((opts.tags ?? []).map((t) => t.trim()).filter(Boolean)));
    const tagsJson = JSON.stringify(tags);
    const content = opts.content.trim();
    if (!content) throw new Error("memory content cannot be empty");
    const source = opts.source?.trim() || "agent";
    this.insertEntry.run(id, content, tagsJson, source, now, now);
    log.debug({ id, tagCount: tags.length, source }, "memory saved");
    return { id, content, tags, source, createdAt: now, updatedAt: now };
  }

  /**
   * BM25 recall. Query can be natural language — FTS5 tokenises it the
   * same way as stored content so you don't need MATCH operators unless
   * you want them.
   *
   *   tagsAny: at least one of these tags must be present (OR)
   *   tagsAll: all of these tags must be present (AND)
   */
  search(query: string, opts: {
    limit?: number;
    tagsAny?: readonly string[];
    tagsAll?: readonly string[];
  } = {}): readonly MemoryHit[] {
    const q = sanitiseFtsQuery(query);
    if (!q) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
    const rows = this.recall.all(q, limit) as Array<{
      id: string; content: string; tagsJson: string; source: string;
      createdAt: number; updatedAt: number; rank: number;
    }>;
    const hits = rows.map((r) => ({
      id: r.id,
      content: r.content,
      tags: JSON.parse(r.tagsJson) as string[],
      source: r.source,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      rank: r.rank,
    }));
    return applyTagFilters(hits, opts);
  }

  getById(id: string): MemoryEntry | null {
    const row = this.selectOne.get(id) as {
      id: string; content: string; tagsJson: string; source: string;
      createdAt: number; updatedAt: number;
    } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      content: row.content,
      tags: JSON.parse(row.tagsJson) as string[],
      source: row.source,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  delete(id: string): boolean {
    return this.deleteOne.run(id).changes > 0;
  }

  listRecentEntries(opts: { limit?: number; offset?: number } = {}): readonly MemoryEntry[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const offset = Math.max(0, opts.offset ?? 0);
    const rows = this.listRecent.all(limit, offset) as Array<{
      id: string; content: string; tagsJson: string; source: string;
      createdAt: number; updatedAt: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      tags: JSON.parse(r.tagsJson) as string[],
      source: r.source,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }
}

/**
 * FTS5 has its own query syntax. If we pass raw user text containing
 * `:`, `(`, `"`, or stray `AND`/`OR` we get syntax errors. Escape each
 * token individually and OR them together — that gives "hit if any of
 * these words match" which matches user intuition for recall.
 */
function sanitiseFtsQuery(raw: string): string {
  const cleaned = raw
    .split(/\s+/)
    .map((t) => t.replace(/["'`]/g, "").trim())
    .filter((t) => t.length > 0 && /[\p{L}\p{N}]/u.test(t));
  if (cleaned.length === 0) return "";
  return cleaned.map((t) => `"${t}"`).join(" OR ");
}

function applyTagFilters<T extends { tags: readonly string[] }>(
  hits: readonly T[],
  opts: { tagsAny?: readonly string[]; tagsAll?: readonly string[] },
): readonly T[] {
  const any = opts.tagsAny?.map((t) => t.toLowerCase());
  const all = opts.tagsAll?.map((t) => t.toLowerCase());
  if (!any && !all) return hits;
  return hits.filter((h) => {
    const lower = h.tags.map((t) => t.toLowerCase());
    if (any && !any.some((t) => lower.includes(t))) return false;
    if (all && !all.every((t) => lower.includes(t))) return false;
    return true;
  });
}
