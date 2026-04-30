/**
 * WatcherStore — event-driven triggers (webhooks, file watchers, polling).
 *
 * A watcher monitors a source and fires an action when a condition is met.
 * Execution is handled by the WatcherRunner (separate from storage).
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import { createLogger } from "../util/logger.js";

const log = createLogger("watchers");

export interface WatcherRow {
  readonly id: string;
  readonly name: string;
  readonly triggerType: "webhook" | "poll" | "file" | "cron" | "integration";
  readonly pattern: string;
  readonly action: string;
  readonly channel: string | null;
  readonly enabled: boolean;
  readonly lastTriggeredAt: number | null;
  readonly triggerCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS watchers (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  trigger_type      TEXT NOT NULL DEFAULT 'webhook',
  pattern           TEXT NOT NULL DEFAULT '',
  action            TEXT NOT NULL DEFAULT '',
  channel           TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_triggered_at INTEGER,
  trigger_count     INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
`;

export class WatcherStore {
  private readonly insert: Database.Statement;
  private readonly selectAll: Database.Statement;
  private readonly selectOne: Database.Statement;
  private readonly updateStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly recordTrigger: Database.Statement;

  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);

    this.insert = db.prepare(
      `INSERT INTO watchers (id, name, trigger_type, pattern, action, channel, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.selectAll = db.prepare(
      `SELECT id, name, trigger_type AS triggerType, pattern, action, channel,
              enabled, last_triggered_at AS lastTriggeredAt, trigger_count AS triggerCount,
              created_at AS createdAt, updated_at AS updatedAt
       FROM watchers ORDER BY created_at DESC`,
    );
    this.selectOne = db.prepare(
      `SELECT id, name, trigger_type AS triggerType, pattern, action, channel,
              enabled, last_triggered_at AS lastTriggeredAt, trigger_count AS triggerCount,
              created_at AS createdAt, updated_at AS updatedAt
       FROM watchers WHERE id = ?`,
    );
    this.updateStmt = db.prepare(
      `UPDATE watchers SET name=?, trigger_type=?, pattern=?, action=?, channel=?, enabled=?, updated_at=? WHERE id=?`,
    );
    this.deleteStmt = db.prepare(`DELETE FROM watchers WHERE id = ?`);
    this.recordTrigger = db.prepare(
      `UPDATE watchers SET last_triggered_at=?, trigger_count=trigger_count+1, updated_at=? WHERE id=?`,
    );
  }

  create(opts: {
    name: string;
    triggerType?: WatcherRow["triggerType"];
    pattern?: string;
    action?: string;
    channel?: string;
  }): WatcherRow {
    const id = randomUUID();
    const now = Date.now();
    this.insert.run(id, opts.name, opts.triggerType ?? "webhook", opts.pattern ?? "", opts.action ?? "", opts.channel ?? null, 1, now, now);
    log.info({ id, name: opts.name }, "watcher created");
    return this.get(id)!;
  }

  list(): readonly WatcherRow[] {
    return this.selectAll.all() as WatcherRow[];
  }

  get(id: string): WatcherRow | null {
    return (this.selectOne.get(id) as WatcherRow) ?? null;
  }

  update(id: string, opts: Partial<Pick<WatcherRow, "name" | "triggerType" | "pattern" | "action" | "channel" | "enabled">>): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    this.updateStmt.run(
      opts.name ?? existing.name,
      opts.triggerType ?? existing.triggerType,
      opts.pattern ?? existing.pattern,
      opts.action ?? existing.action,
      opts.channel ?? existing.channel,
      opts.enabled !== undefined ? (opts.enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
      Date.now(),
      id,
    );
    return true;
  }

  delete(id: string): boolean {
    return this.deleteStmt.run(id).changes > 0;
  }

  markTriggered(id: string): void {
    const now = Date.now();
    this.recordTrigger.run(now, now, id);
  }
}
