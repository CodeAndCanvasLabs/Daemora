/**
 * ConfigManager — single, typed, source-aware accessor for all of
 * Daemora's configuration. Owns the vault + settings store + boot env.
 *
 *   const cfg = ConfigManager.open({ dataDir });
 *   cfg.vault.unlock(passphrase);
 *
 *   cfg.setting("DEFAULT_MODEL");        // typed, falls back to default
 *   cfg.secret("ANTHROPIC_API_KEY");     // Secret | undefined
 *   cfg.source("DEFAULT_MODEL");         // "settings" | "default"
 *
 *   cfg.on("change", ({ key, source }) => …);  // react to changes
 */

import { mkdirSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";

import Database from "better-sqlite3";

import { createLogger } from "../util/logger.js";
import { readBootEnv, type BootEnv } from "./env.js";
import {
  allFields,
  isSecret as schemaIsSecret,
  isSetting as schemaIsSetting,
  type ConfigSource,
  type SecretKey,
  type SettingKey,
  type SettingValue,
} from "./schema.js";
import { Secret } from "./Secret.js";
import { SecretVault } from "./SecretVault.js";
import { SettingsStore } from "./SettingsStore.js";

const log = createLogger("config");

export interface ConfigChangeEvent {
  readonly key: string;
  readonly kind: "secret" | "setting";
  readonly action: "set" | "delete";
}

export class ConfigManager extends EventEmitter {
  readonly vault: SecretVault;
  readonly settings: SettingsStore;
  readonly env: BootEnv;
  private readonly db: Database.Database;

  /**
   * Shared SQLite handle. Other subsystems (SessionStore, MemoryStore, …)
   * reuse this so we keep one file, one WAL context, one close() call —
   * not N independent connections stepping on each other.
   */
  get database(): Database.Database {
    return this.db;
  }

  private constructor(db: Database.Database, env: BootEnv) {
    super();
    this.db = db;
    this.env = env;
    this.vault = new SecretVault(db);
    this.settings = new SettingsStore(db);

    // Re-emit downstream changes through one channel so consumers don't
    // need to subscribe to vault + settings separately.
    this.vault.on("set", (key: string) => this.emit("change", { key, kind: "secret", action: "set" } satisfies ConfigChangeEvent));
    this.vault.on("delete", (key: string) => this.emit("change", { key, kind: "secret", action: "delete" } satisfies ConfigChangeEvent));
    this.settings.on("change", ({ key }: { key: string }) =>
      this.emit("change", { key, kind: "setting", action: "set" } satisfies ConfigChangeEvent),
    );
  }

  static open(opts: { dataDir?: string; dbName?: string } = {}): ConfigManager {
    const env = readBootEnv();
    const dataDir = opts.dataDir ?? env.dataDir;
    mkdirSync(dataDir, { recursive: true });

    const dbPath = join(dataDir, opts.dbName ?? "daemora.db");
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    log.info({ dbPath }, "config opened");

    return new ConfigManager(db, env);
  }

  /** Strongly-typed setting accessor. */
  setting<K extends SettingKey>(key: K): SettingValue<K> {
    return this.settings.get(key);
  }

  /** Get a secret. Returns undefined if vault locked OR key not set. */
  secret(key: SecretKey): Secret | undefined {
    return this.vault.get(String(key));
  }

  /** Where did this value come from? Useful for the UI's "show source" affordance. */
  source(key: string): ConfigSource {
    if (schemaIsSecret(key)) {
      return this.vault.has(key) ? "vault" : "default";
    }
    if (schemaIsSetting(key)) {
      return this.settings.has(key as SettingKey) ? "settings" : "default";
    }
    // Env-only fields
    if (process.env[key] !== undefined) return "env";
    return "default";
  }

  /**
   * Snapshot of every known field with its current value + source.
   * Secrets are returned as `Secret` instances (auto-redacted on log).
   * Use this for /api/config/inspect.
   */
  inspect(): readonly InspectedField[] {
    return Array.from(allFields.entries()).map(([key, def]) => {
      if (def.kind === "setting") {
        return {
          key,
          kind: "setting",
          group: def.group,
          label: def.label,
          description: def.description,
          source: this.source(key),
          value: this.settings.get(key as SettingKey),
          editable: def.editable,
        };
      }
      return {
        key,
        kind: "secret",
        group: def.group,
        label: def.label,
        description: def.description,
        source: this.source(key),
        isSet: this.vault.has(key),
        hint: this.vault.get(key)?.hint(),
        ...(def.oauth ? { oauth: def.oauth } : {}),
      };
    });
  }

  close(): void {
    this.vault.lock();
    this.db.close();
  }
}

export type InspectedField =
  | {
      readonly kind: "setting";
      readonly key: string;
      readonly group: string;
      readonly label: string;
      readonly description: string;
      readonly source: ConfigSource;
      readonly value: unknown;
      readonly editable: boolean;
    }
  | {
      readonly kind: "secret";
      readonly key: string;
      readonly group: string;
      readonly label: string;
      readonly description: string;
      readonly source: ConfigSource;
      readonly isSet: boolean;
      readonly hint: string | undefined;
      readonly oauth?: { integration: string; tokenType: string };
    };
