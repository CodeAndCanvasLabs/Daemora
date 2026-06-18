/**
 * MasterKeyVault — operator-held key-encryption key for per-tenant
 * secrets. Wraps AES-256-GCM with HKDF-derived per-tenant subkeys so
 * one operator KEK protects every tenant's API keys.
 *
 * Lives in env (`MASTER_KEK`, base64-encoded 32 bytes) — never on
 * disk inside any tenant's dir, never logged, never written to the
 * registry DB. Lose this and every encrypted tenant API key is dead.
 *
 * Threat model: protect tenant secrets at rest in the registry DB.
 * Does NOT protect against:
 *  - an operator with access to the running control plane (they hold
 *    the KEK in memory)
 *  - a stolen registry DB combined with a stolen MASTER_KEK
 *  - in-memory exposure (the decrypted value lives in the spawn env;
 *    that's intentional — we have to give it to the tenant somehow)
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const HKDF_INFO_PREFIX = "daemora.tenant-key.v1";

export class MasterKeyVault {
  private readonly kek: Buffer;

  constructor(kek: Buffer) {
    if (kek.length !== KEY_LEN) {
      throw new Error(`MASTER_KEK must be ${KEY_LEN} bytes; got ${kek.length}`);
    }
    this.kek = kek;
  }

  /**
   * Load from env `MASTER_KEK` (base64). Throws if missing or wrong
   * length — fail loud at boot, never silently boot with no encryption.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): MasterKeyVault {
    const raw = env["MASTER_KEK"];
    if (!raw) {
      throw new Error("MASTER_KEK env var is required for multi-tenant mode (32 bytes base64)");
    }
    const buf = Buffer.from(raw, "base64");
    return new MasterKeyVault(buf);
  }

  /**
   * Convenience: load if present, else return undefined so single-tenant
   * mode can boot without the env.
   */
  static fromEnvOptional(env: NodeJS.ProcessEnv = process.env): MasterKeyVault | undefined {
    return env["MASTER_KEK"] ? MasterKeyVault.fromEnv(env) : undefined;
  }

  encrypt(tenantId: string, keyName: string, plaintext: string): { ciphertext: Buffer; nonce: Buffer } {
    const key = this.deriveSubkey(tenantId, keyName);
    const nonce = randomBytes(NONCE_LEN);
    const cipher = createCipheriv(ALGO, key, nonce);
    const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Store tag concatenated to ciphertext — single column in the DB.
    return { ciphertext: Buffer.concat([enc, tag]), nonce };
  }

  decrypt(tenantId: string, keyName: string, ciphertext: Buffer, nonce: Buffer): string {
    if (ciphertext.length < TAG_LEN) throw new Error("ciphertext too short");
    const tag = ciphertext.subarray(ciphertext.length - TAG_LEN);
    const data = ciphertext.subarray(0, ciphertext.length - TAG_LEN);
    const key = this.deriveSubkey(tenantId, keyName);
    const decipher = createDecipheriv(ALGO, key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf-8");
  }

  /**
   * Derive a per-(tenant, key) subkey from the master KEK so:
   *  - a leaked subkey doesn't expose the master.
   *  - the same plaintext under two tenants yields different ciphertexts
   *    even if our nonce generation ever degraded.
   */
  private deriveSubkey(tenantId: string, keyName: string): Buffer {
    const info = Buffer.from(`${HKDF_INFO_PREFIX}|${tenantId}|${keyName}`, "utf-8");
    const salt = Buffer.alloc(0); // info-bound; no salt needed for our use
    const derived = hkdfSync("sha256", this.kek, salt, info, KEY_LEN);
    return Buffer.from(derived);
  }

  /**
   * Helper for tests / migrations — round-trips a value through the
   * encrypt/decrypt pair and uses timing-safe compare.
   */
  selfTest(): boolean {
    const tenantId = "self-test-tenant";
    const keyName = "PROBE";
    const plain = "the quick brown fox";
    const { ciphertext, nonce } = this.encrypt(tenantId, keyName, plain);
    const out = this.decrypt(tenantId, keyName, ciphertext, nonce);
    return timingSafeEqual(Buffer.from(plain, "utf-8"), Buffer.from(out, "utf-8"));
  }
}

/** Generate a fresh 32-byte master KEK, base64-encoded. CLI helper. */
export function generateMasterKek(): string {
  return randomBytes(KEY_LEN).toString("base64");
}
