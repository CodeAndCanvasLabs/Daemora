/**
 * DeliveryPresetStore — named groups of `(channel, channelMeta)` pairs.
 *
 * A preset lets a cron job / watcher reference a single name instead of
 * repeating a list of channel destinations. Typical shapes:
 *
 *   id: "team-alerts", name: "Team Alerts",
 *   targets: [
 *     { channel: "slack",    channelMeta: { channelId: "C123" } },
 *     { channel: "telegram", channelMeta: { chatId: "-10023" } },
 *   ]
 *
 * The CronExecutor / WatcherRunner look preset up by name, resolve to
 * the full targets list, and fan out the reply. If a preset changes,
 * every job pointed at it picks up the change on the next fire.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import { createLogger } from "../util/logger.js";
import { ValidationError } from "../util/errors.js";

const log = createLogger("delivery-presets");

export interface DeliveryTarget {
  readonly channel: string;
  readonly channelMeta?: Record<string, unknown> | null;
}

export interface DeliveryPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly targets: readonly DeliveryTarget[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SavePresetInput {
  readonly id?: string;
  readonly name: string;
  readonly description?: string | null;
  readonly targets: readonly DeliveryTarget[];
}

interface PresetRow {
  id: string;
  name: string;
  description: string | null;
  targets_json: string;
  created_at: number;
  updated_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS delivery_presets (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  targets_json  TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_presets_name ON delivery_presets(name COLLATE NOCASE);
`;

export class DeliveryPresetStore {
  private readonly stmts: ReturnType<DeliveryPresetStore["prepare"]>;

  constructor(private readonly db: Database.Database) {
    this.db.exec(SCHEMA);
    this.stmts = this.prepare();
    log.debug("delivery preset store ready");
  }

  save(input: SavePresetInput): DeliveryPreset {
    if (!input.name?.trim()) throw new ValidationError("Preset name is required.");
    const id = input.id ?? randomUUID().slice(0, 8);
    const targetsJson = JSON.stringify(input.targets ?? []);
    const now = Date.now();
    this.stmts.upsert.run(id, input.name, input.description ?? null, targetsJson, now, now);
    const row = this.stmts.byId.get(id) as PresetRow;
    return rowToPreset(row);
  }

  get(id: string): DeliveryPreset | null {
    const row = this.stmts.byId.get(id) as PresetRow | undefined;
    return row ? rowToPreset(row) : null;
  }

  getByName(name: string): DeliveryPreset | null {
    const row = this.stmts.byName.get(name) as PresetRow | undefined;
    return row ? rowToPreset(row) : null;
  }

  list(): readonly DeliveryPreset[] {
    return (this.stmts.all.all() as PresetRow[]).map(rowToPreset);
  }

  delete(id: string): boolean {
    return this.stmts.delete.run(id).changes > 0;
  }

  private prepare() {
    return {
      upsert: this.db.prepare(
        `INSERT INTO delivery_presets (id, name, description, targets_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           targets_json = excluded.targets_json,
           updated_at = excluded.updated_at`,
      ),
      byId: this.db.prepare(`SELECT * FROM delivery_presets WHERE id = ?`),
      byName: this.db.prepare(`SELECT * FROM delivery_presets WHERE name = ? COLLATE NOCASE`),
      all: this.db.prepare(`SELECT * FROM delivery_presets ORDER BY name`),
      delete: this.db.prepare(`DELETE FROM delivery_presets WHERE id = ?`),
    };
  }
}

function rowToPreset(row: PresetRow): DeliveryPreset {
  let targets: DeliveryTarget[] = [];
  try {
    const parsed = JSON.parse(row.targets_json) as unknown;
    if (Array.isArray(parsed)) {
      targets = parsed.filter((t): t is DeliveryTarget =>
        typeof t === "object" && t !== null && typeof (t as { channel?: unknown }).channel === "string",
      );
    }
  } catch {
    // malformed row — surface as empty targets rather than crash
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    targets,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
