import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { readFileSync, existsSync, renameSync, mkdirSync } from "fs";
import { join } from "path";
import { config } from "../config/default.js";
import eventBus from "../core/EventBus.js";
import { getDb } from "../storage/Database.js";

/**
 * Secret Vault — encrypted secret storage in SQLite.
 *
 * All API keys, channel tokens, and credentials are encrypted at rest using
 * AES-256-GCM with the user-provided master passphrase.
 *
 * Security model:
 * - User provides a master passphrase at startup (daemora start)
 * - Passphrase → scrypt → 256-bit key (with per-vault salt stored in SQLite)
 * - Each secret encrypted individually with unique IV
 * - Stored in SQLite vault_entries table (not flat files)
 * - No plaintext secrets anywhere on disk
 * - .env is for infrastructure config only (PORT, DATA_DIR) — never secrets
 *
 * Migration: existing .vault.enc file is imported into SQLite on first unlock,
 * then renamed to .vault.enc.bak.
 */

const SALT_KEY   = "__vault_salt__";
const ALGORITHM  = "aes-256-gcm";
const SCRYPT_N   = 16384;
const SCRYPT_R   = 8;
const SCRYPT_P   = 1;
const KEY_LENGTH = 32;

// Legacy flat file paths (for one-time migration)
const LEGACY_VAULT_FILE = join(config.dataDir, ".vault.enc");
const LEGACY_SALT_FILE  = join(config.dataDir, ".vault.salt");

class SecretVault {
  constructor() {
    this.encryptionKey = null;
    this.secrets = null; // decrypted map in memory (only while unlocked)
    this.unlocked = false;
  }

  /**
   * Unlock the vault with the master passphrase.
   * Initialises SQLite, derives the encryption key, decrypts all entries into memory.
   * Must be called before any get/set operations.
   */
  unlock(passphrase) {
    if (!passphrase || passphrase.length < 8) {
      throw new Error("Passphrase must be at least 8 characters");
    }

    const db = getDb(); // ensures vault_entries table exists

    // Get or create salt (stored as a special vault_entries row)
    let salt;
    const saltRow = db.prepare("SELECT value FROM vault_entries WHERE key = ?").get(SALT_KEY);
    if (saltRow) {
      salt = Buffer.from(saltRow.value, "hex");
    } else {
      // Check legacy salt file first (migration path)
      if (existsSync(LEGACY_SALT_FILE)) {
        salt = readFileSync(LEGACY_SALT_FILE);
      } else {
        salt = randomBytes(32);
      }
      db.prepare(
        "INSERT OR REPLACE INTO vault_entries (key, value, updated_at) VALUES (?, ?, datetime('now'))"
      ).run(SALT_KEY, salt.toString("hex"));
    }

    // Derive encryption key from passphrase + salt
    this.encryptionKey = scryptSync(passphrase, salt, KEY_LENGTH, {
      N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
    });

    // Load secrets from SQLite
    try {
      const rows = db.prepare(
        "SELECT key, value FROM vault_entries WHERE key != ?"
      ).all(SALT_KEY);

      this.secrets = {};
      for (const row of rows) {
        try {
          this.secrets[row.key] = this._decrypt(row.value);
        } catch {
          // Skip entries that fail to decrypt (wrong passphrase would throw on first one)
          throw new Error("Failed to unlock vault. Wrong passphrase or corrupted entry.");
        }
      }
    } catch (err) {
      this.encryptionKey = null;
      this.secrets = null;
      throw err;
    }

    this.unlocked = true;

    // One-time migration from legacy .vault.enc flat file
    this._migrateLegacyVault();

    return true;
  }

  /**
   * Lock the vault — wipe decrypted secrets from memory.
   */
  lock() {
    this.secrets = null;
    this.encryptionKey = null;
    this.unlocked = false;
  }

  /**
   * Store a secret in the vault.
   */
  set(key, value) {
    this._ensureUnlocked();
    if (key === SALT_KEY) throw new Error("Reserved key");
    const encrypted = this._encrypt(value);
    getDb().prepare(
      "INSERT OR REPLACE INTO vault_entries (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).run(key, encrypted);
    this.secrets[key] = value;
    eventBus.emitEvent("vault:secret_stored", { key });
    return true;
  }

  /**
   * Retrieve a decrypted secret from memory.
   */
  get(key) {
    this._ensureUnlocked();
    return this.secrets[key] || null;
  }

  /**
   * Delete a secret.
   */
  delete(key) {
    this._ensureUnlocked();
    getDb().prepare("DELETE FROM vault_entries WHERE key = ?").run(key);
    delete this.secrets[key];
    return true;
  }

  /**
   * List all secret keys (NOT values).
   */
  list() {
    this._ensureUnlocked();
    return Object.entries(this.secrets).map(([key, value]) => ({
      key,
      length: value?.length || 0,
      preview: `${value?.slice(0, 4)}...`,
    }));
  }

  /**
   * Check if the vault has been set up (has any entries in SQLite or legacy flat file).
   */
  exists() {
    try {
      const db = getDb();
      const row = db.prepare("SELECT COUNT(*) as cnt FROM vault_entries").get();
      if (row.cnt > 0) return true;
    } catch { /* DB not ready yet */ }
    return existsSync(LEGACY_VAULT_FILE);
  }

  isUnlocked() { return this.unlocked; }

  /**
   * Get all secrets as a plain object (for process.env injection at startup).
   */
  getAsEnv() {
    this._ensureUnlocked();
    return { ...this.secrets };
  }

  /**
   * Import secrets from a .env file into the vault.
   */
  importFromEnv(envPath) {
    this._ensureUnlocked();
    if (!existsSync(envPath)) throw new Error(`.env file not found: ${envPath}`);

    const lines = readFileSync(envPath, "utf-8").split("\n");
    let imported = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value && value.length >= 8) {
        this.set(key, value);
        imported++;
      }
    }
    return imported;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _ensureUnlocked() {
    if (!this.unlocked || !this.secrets) {
      throw new Error("Vault is locked. Call vault.unlock(passphrase) first.");
    }
  }

  _encrypt(plaintext) {
    const iv = randomBytes(16);
    const cipher = createCipheriv(ALGORITHM, this.encryptionKey, iv);
    let enc = cipher.update(plaintext, "utf-8", "hex");
    enc += cipher.final("hex");
    const tag = cipher.getAuthTag().toString("hex");
    return `${iv.toString("hex")}:${tag}:${enc}`;
  }

  _decrypt(encryptedStr) {
    const parts = encryptedStr.split(":");
    if (parts.length < 3) throw new Error("Invalid vault entry format");
    const [ivHex, tagHex, ...rest] = parts;
    const iv  = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const enc = Buffer.from(rest.join(":"), "hex");
    const decipher = createDecipheriv(ALGORITHM, this.encryptionKey, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc).toString("utf8") + decipher.final("utf8");
  }

  /**
   * One-time migration: import .vault.enc flat file into SQLite, then rename it.
   */
  _migrateLegacyVault() {
    if (!existsSync(LEGACY_VAULT_FILE)) return;
    try {
      const encrypted = readFileSync(LEGACY_VAULT_FILE, "utf-8").trim();
      const decrypted = this._decrypt(encrypted);
      const legacySecrets = JSON.parse(decrypted);
      let migrated = 0;
      for (const [key, value] of Object.entries(legacySecrets)) {
        if (!this.secrets[key]) { // don't overwrite existing SQLite entries
          this.set(key, value);
          migrated++;
        }
      }
      renameSync(LEGACY_VAULT_FILE, LEGACY_VAULT_FILE + ".bak");
      if (existsSync(LEGACY_SALT_FILE)) renameSync(LEGACY_SALT_FILE, LEGACY_SALT_FILE + ".bak");
      if (migrated > 0) console.log(`[Vault] Migrated ${migrated} secret(s) from flat file to SQLite`);
    } catch (err) {
      console.log(`[Vault] Legacy vault migration skipped: ${err.message}`);
    }
  }
}

const secretVault = new SecretVault();
export default secretVault;
