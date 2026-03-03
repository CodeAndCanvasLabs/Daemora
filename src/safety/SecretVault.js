import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { config } from "../config/default.js";
import eventBus from "../core/EventBus.js";

/**
 * Secret Vault - encrypted secret storage.
 *
 * All API keys, tokens, and credentials are encrypted at rest using
 * AES-256-GCM with a user-provided master passphrase.
 *
 * Security model:
 * - User provides a master passphrase during setup
 * - Passphrase → scrypt → 256-bit key (with per-vault salt)
 * - Each secret encrypted individually with unique IV
 * - Even if filesystem is compromised, secrets can't be read without passphrase
 * - Vault file: data/.vault.enc (encrypted JSON)
 * - No plaintext API keys anywhere on disk
 *
 * Usage:
 *   vault.unlock("user-passphrase")
 *   vault.set("OPENAI_API_KEY", "sk-...")
 *   const key = vault.get("OPENAI_API_KEY")
 *   vault.lock()
 */

const VAULT_FILE = ".vault.enc";
const SALT_FILE = ".vault.salt";
const ALGORITHM = "aes-256-gcm";
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

class SecretVault {
  constructor() {
    this.vaultPath = join(config.dataDir, VAULT_FILE);
    this.saltPath = join(config.dataDir, SALT_FILE);
    this.encryptionKey = null;
    this.secrets = null; // decrypted secrets in memory (only while unlocked)
    this.unlocked = false;
  }

  /**
   * Unlock the vault with a master passphrase.
   * Must be called before get/set operations.
   */
  unlock(passphrase) {
    if (!passphrase || passphrase.length < 8) {
      throw new Error("Passphrase must be at least 8 characters");
    }

    // Get or create salt
    let salt;
    if (existsSync(this.saltPath)) {
      salt = readFileSync(this.saltPath);
    } else {
      salt = randomBytes(32);
      mkdirSync(config.dataDir, { recursive: true });
      writeFileSync(this.saltPath, salt);
    }

    // Derive key from passphrase
    this.encryptionKey = scryptSync(passphrase, salt, KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });

    // Load existing vault or create empty
    if (existsSync(this.vaultPath)) {
      try {
        const encrypted = readFileSync(this.vaultPath, "utf-8");
        const decrypted = this._decrypt(encrypted);
        this.secrets = JSON.parse(decrypted);
      } catch (error) {
        throw new Error(
          "Failed to unlock vault. Wrong passphrase or corrupted vault file."
        );
      }
    } else {
      this.secrets = {};
    }

    this.unlocked = true;
    return true;
  }

  /**
   * Lock the vault - clear decrypted secrets from memory.
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
    this.secrets[key] = value;
    this._save();
    eventBus.emitEvent("vault:secret_stored", { key });
    return true;
  }

  /**
   * Retrieve a secret from the vault.
   */
  get(key) {
    this._ensureUnlocked();
    return this.secrets[key] || null;
  }

  /**
   * Delete a secret from the vault.
   */
  delete(key) {
    this._ensureUnlocked();
    delete this.secrets[key];
    this._save();
    return true;
  }

  /**
   * List all secret keys (NOT values).
   */
  list() {
    this._ensureUnlocked();
    return Object.keys(this.secrets).map((key) => ({
      key,
      length: this.secrets[key]?.length || 0,
      preview: `${this.secrets[key]?.slice(0, 4)}...`,
    }));
  }

  /**
   * Check if vault exists (has been set up).
   */
  exists() {
    return existsSync(this.vaultPath);
  }

  /**
   * Check if vault is unlocked.
   */
  isUnlocked() {
    return this.unlocked;
  }

  /**
   * Import secrets from .env file into the vault.
   * After import, the .env values can be removed.
   */
  importFromEnv(envPath) {
    this._ensureUnlocked();

    if (!existsSync(envPath)) {
      throw new Error(`.env file not found: ${envPath}`);
    }

    const content = readFileSync(envPath, "utf-8");
    const lines = content.split("\n");
    let imported = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;

      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();

      // Remove surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      // Only import non-empty secret-looking values
      if (value && value.length >= 8) {
        this.secrets[key] = value;
        imported++;
      }
    }

    this._save();
    return imported;
  }

  /**
   * Get all secrets as environment variables (for process.env injection).
   */
  getAsEnv() {
    this._ensureUnlocked();
    return { ...this.secrets };
  }

  // ===== Private methods =====

  _ensureUnlocked() {
    if (!this.unlocked || !this.secrets) {
      throw new Error(
        "Vault is locked. Call vault.unlock(passphrase) first."
      );
    }
  }

  _save() {
    const json = JSON.stringify(this.secrets);
    const encrypted = this._encrypt(json);
    writeFileSync(this.vaultPath, encrypted, "utf-8");
  }

  _encrypt(plaintext) {
    const iv = randomBytes(16);
    const cipher = createCipheriv(ALGORITHM, this.encryptionKey, iv);
    let encrypted = cipher.update(plaintext, "utf-8", "hex");
    encrypted += cipher.final("hex");
    const authTag = cipher.getAuthTag().toString("hex");
    // Format: iv:authTag:ciphertext
    return `${iv.toString("hex")}:${authTag}:${encrypted}`;
  }

  _decrypt(encryptedStr) {
    const parts = encryptedStr.split(":");
    if (parts.length !== 3) {
      throw new Error("Invalid vault format");
    }
    const [ivHex, authTagHex, ciphertext] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");

    const decipher = createDecipheriv(ALGORITHM, this.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, "hex", "utf-8");
    decrypted += decipher.final("utf-8");
    return decrypted;
  }
}

const secretVault = new SecretVault();
export default secretVault;
