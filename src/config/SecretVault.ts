/**
 * SecretVault — encrypted SQLite KV for API keys, OAuth tokens, anything
 * that must never sit in process.env or plaintext on disk.
 *
 * Crypto choices (defended):
 *   - scrypt(N=2^15, r=8, p=1) to derive a 256-bit key from passphrase.
 *     Values picked so unlock is ~100 ms on M-series; 1+ second on commodity.
 *   - aes-256-gcm per entry, with a fresh 96-bit IV per write.
 *     Authenticated encryption stops swap-the-blob attacks.
 *   - Salt is per-vault, stored in the same DB under a reserved __vault_salt__ row.
 *     Re-using a salt across users is fine here; we're a single-user app.
 *
 * Lifecycle:
 *   - new() does NOT unlock. Call unlock(passphrase) before reading secrets.
 *   - lock() drops the in-memory key. Subsequent reads return undefined.
 *   - State changes emit events so subscribers (ModelRouter, integrations)
 *     can react.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { EventEmitter } from "node:events";

import type Database from "better-sqlite3";

import { ConfigError, NotFoundError, ValidationError } from "../util/errors.js";
import { createLogger } from "../util/logger.js";
import { Secret } from "./Secret.js";

const log = createLogger("vault");

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_KEY = "__vault_salt__";

export type VaultEvent = "unlocked" | "locked" | "set" | "delete";

export class SecretVault extends EventEmitter {
  #key: Buffer | null = null;
  readonly #salt: Buffer;

  constructor(private readonly db: Database.Database) {
    super();
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS vault_entries (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )`,
      )
      .run();

    // Per-vault salt — created once on first use and never rotated.
    const existing = this.readRaw(SALT_KEY);
    if (existing) {
      this.#salt = Buffer.from(existing, "hex");
    } else {
      this.#salt = randomBytes(16);
      this.writeRaw(SALT_KEY, this.#salt.toString("hex"));
    }
  }

  /** Has this vault been initialized with anything (i.e. has it been unlocked at least once)? */
  exists(): boolean {
    const row = this.db
      .prepare("SELECT count(*) as n FROM vault_entries WHERE key != ?")
      .get(SALT_KEY) as { n: number } | undefined;
    return (row?.n ?? 0) > 0;
  }

  isUnlocked(): boolean {
    return this.#key !== null;
  }

  /**
   * Unlock the vault. On first ever call (no entries yet), the
   * passphrase is accepted as-is and becomes the new vault password.
   * On subsequent calls, the passphrase is verified by attempting to
   * decrypt the first non-salt entry — wrong passphrase → throws
   * `ValidationError`.
   */
  unlock(passphrase: string): void {
    if (passphrase.length < 8) {
      throw new ValidationError("Passphrase must be at least 8 characters.");
    }
    const candidate = scryptSync(passphrase, this.#salt, KEY_LEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: 64 * 1024 * 1024,
    });

    // Verify by trying to decrypt any existing entry.
    const sample = this.db
      .prepare("SELECT key, value FROM vault_entries WHERE key != ? LIMIT 1")
      .get(SALT_KEY) as { key: string; value: string } | undefined;

    if (sample) {
      try {
        decryptWith(sample.value, candidate);
      } catch {
        throw new ValidationError("Incorrect vault passphrase.");
      }
    }

    this.#key = candidate;
    log.info("vault unlocked");
    this.emit("unlocked" satisfies VaultEvent);
  }

  lock(): void {
    if (this.#key) this.#key.fill(0);
    this.#key = null;
    log.info("vault locked");
    this.emit("locked" satisfies VaultEvent);
  }

  set(key: string, value: string): void {
    if (key === SALT_KEY) throw new ValidationError("Reserved key");
    if (!this.#key) throw new ConfigError("Vault is locked. Unlock before writing secrets.");
    if (typeof value !== "string" || value.length === 0) {
      throw new ValidationError("Secret value must be a non-empty string.");
    }
    const blob = encryptWith(value, this.#key);
    this.db
      .prepare(
        `INSERT INTO vault_entries (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`,
      )
      .run(key, blob);
    this.emit("set" satisfies VaultEvent, key);
  }

  /**
   * Read a secret. Returns `undefined` if the key isn't set OR the
   * vault is locked. Caller MUST check both — by design, locked vault
   * doesn't throw, so an integration can degrade gracefully.
   */
  get(key: string): Secret | undefined {
    if (!this.#key) return undefined;
    const row = this.db
      .prepare("SELECT value FROM vault_entries WHERE key = ?")
      .get(key) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      return Secret.of(decryptWith(row.value, this.#key));
    } catch (e) {
      // Corrupt entry — surface, don't silently swallow.
      log.error({ key, err: (e as Error).message }, "vault entry decrypt failed");
      return undefined;
    }
  }

  has(key: string): boolean {
    if (key === SALT_KEY) return false;
    const row = this.db
      .prepare("SELECT 1 FROM vault_entries WHERE key = ?")
      .get(key);
    return row !== undefined;
  }

  delete(key: string): boolean {
    if (key === SALT_KEY) throw new ValidationError("Reserved key");
    const info = this.db.prepare("DELETE FROM vault_entries WHERE key = ?").run(key);
    if (info.changes > 0) {
      this.emit("delete" satisfies VaultEvent, key);
      return true;
    }
    return false;
  }

  /** Return all known keys (no values). Useful for the UI key list. */
  keys(): readonly string[] {
    const rows = this.db
      .prepare("SELECT key FROM vault_entries WHERE key != ? ORDER BY key")
      .all(SALT_KEY) as { key: string }[];
    return rows.map((r) => r.key);
  }

  // ── Raw read/write for the salt only ─────────────────────────────────────

  private readRaw(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM vault_entries WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  private writeRaw(key: string, value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO vault_entries (key, value) VALUES (?, ?)")
      .run(key, value);
  }
}

function encryptWith(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

function decryptWith(blob: string, key: Buffer): string {
  const parts = blob.split(".");
  if (parts.length !== 3) throw new NotFoundError("Malformed vault entry");
  const [ivB64, tagB64, encB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const enc = Buffer.from(encB64, "base64");
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new NotFoundError("Malformed vault entry");
  }
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf-8");
}
