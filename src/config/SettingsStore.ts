/**
 * SettingsStore — plain SQLite KV for non-secret user preferences.
 * Editable via UI, hot-reloadable, schema-validated on write.
 *
 * Storage: TEXT column holding JSON-encoded values (so booleans, numbers,
 * arrays, null are all preserved without an extra type column).
 */

import { EventEmitter } from "node:events";

import type Database from "better-sqlite3";
import type { z } from "zod";

import { ValidationError } from "../util/errors.js";
import { createLogger } from "../util/logger.js";
import { settings as settingsSchema, type SettingKey } from "./schema.js";

const log = createLogger("settings");

export type SettingsEvent = "change";

interface SettingsRow {
  key: string;
  value: string;
}

export class SettingsStore extends EventEmitter {
  constructor(private readonly db: Database.Database) {
    super();
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS settings_entries (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT DEFAULT (datetime('now'))
        )`,
      )
      .run();
  }

  /**
   * Get a setting. Returns the schema default if unset.
   */
  get<K extends SettingKey>(key: K): z.infer<(typeof settingsSchema)[K]["schema"]> {
    const def = settingsSchema[key];
    if (!def) throw new ValidationError(`Unknown setting key: ${String(key)}`);

    const row = this.db
      .prepare("SELECT value FROM settings_entries WHERE key = ?")
      .get(String(key)) as SettingsRow | undefined;

    if (!row) return def.defaultValue as z.infer<(typeof settingsSchema)[K]["schema"]>;

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      log.warn({ key }, "settings row is not valid JSON; falling back to default");
      return def.defaultValue as z.infer<(typeof settingsSchema)[K]["schema"]>;
    }

    const validated = def.schema.safeParse(parsed);
    if (!validated.success) {
      log.warn({ key, issues: validated.error.issues }, "stored value failed schema; using default");
      return def.defaultValue as z.infer<(typeof settingsSchema)[K]["schema"]>;
    }
    return validated.data as z.infer<(typeof settingsSchema)[K]["schema"]>;
  }

  /**
   * Whether a key has an explicitly-set value (vs falling back to default).
   * Useful for the UI to distinguish "user picked X" from "X is the default".
   */
  has<K extends SettingKey>(key: K): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM settings_entries WHERE key = ?")
      .get(String(key));
    return row !== undefined;
  }

  /**
   * Set a setting. Value is validated against the schema; throws
   * ValidationError on bad input. Emits a "change" event so reactive
   * subscribers (ModelRouter, etc.) can update.
   */
  set<K extends SettingKey>(key: K, value: z.infer<(typeof settingsSchema)[K]["schema"]>): void {
    const def = settingsSchema[key];
    if (!def) throw new ValidationError(`Unknown setting key: ${String(key)}`);

    const validated = def.schema.safeParse(value);
    if (!validated.success) {
      throw new ValidationError(`Invalid value for ${String(key)}: ${validated.error.message}`);
    }

    this.db
      .prepare(
        `INSERT INTO settings_entries (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`,
      )
      .run(String(key), JSON.stringify(validated.data));

    this.emit("change" satisfies SettingsEvent, { key: String(key), value: validated.data });
  }

  /** Reset a setting back to its schema default. */
  reset<K extends SettingKey>(key: K): boolean {
    const def = settingsSchema[key];
    if (!def) throw new ValidationError(`Unknown setting key: ${String(key)}`);
    const info = this.db.prepare("DELETE FROM settings_entries WHERE key = ?").run(String(key));
    if (info.changes > 0) {
      this.emit("change" satisfies SettingsEvent, { key: String(key), value: def.defaultValue });
      return true;
    }
    return false;
  }

  /** All known settings with their resolved value + source ("settings" or "default"). */
  inspectAll(): readonly { key: string; value: unknown; source: "settings" | "default" }[] {
    return (Object.keys(settingsSchema) as SettingKey[]).map((k) => ({
      key: String(k),
      value: this.get(k),
      source: this.has(k) ? "settings" : "default",
    }));
  }

  // ── Generic KV (for forward-compat keys the UI writes) ────────

  /** Store an arbitrary key/value pair not in the schema. */
  setGeneric(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings_entries (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`,
      )
      .run(key, JSON.stringify(value));
  }

  /** Check if a generic key exists. */
  hasGeneric(key: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM settings_entries WHERE key = ?")
      .get(key);
    return row !== undefined;
  }

  /** Read a generic key. */
  getGeneric(key: string): unknown {
    const row = this.db
      .prepare("SELECT value FROM settings_entries WHERE key = ?")
      .get(key) as SettingsRow | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.value); } catch { return row.value; }
  }
}
