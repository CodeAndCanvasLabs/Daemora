/**
 * WebhookTokenStore — per-watcher bearer token + HMAC secret.
 *
 * Two secrets per watcher, different storage models because they're
 * used differently:
 *
 *   bearer:    compared against an incoming `Authorization: Bearer`.
 *              One-way sha256 hashed — DB leak can't replay.
 *
 *   hmacSecret: required to COMPUTE HMAC signatures on every incoming
 *              payload (for GitHub/Stripe/generic). Must be reversible.
 *              Stored AES-256-GCM-encrypted with a sub-key derived from
 *              the auth signing key. DB leak without the key file = no
 *              plaintext recovery.
 *
 * Plaintext is shown to the user ONCE on issue/rotate — they must
 * paste it into the provider's dashboard at that moment. After that
 * the server can decrypt it internally but the UI never exposes it.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

import { createLogger } from "../util/logger.js";

const log = createLogger("webhook.tokens");

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS webhook_tokens (
  watcher_id     TEXT PRIMARY KEY,
  bearer_hash    TEXT NOT NULL,
  hmac_cipher    TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  rotated_at     INTEGER,
  revoked_at     INTEGER
);
`;

export interface WebhookTokenRow {
  readonly watcherId: string;
  readonly bearerHash: string;
  readonly hmacCipher: string;
  readonly createdAt: number;
  readonly rotatedAt: number | null;
  readonly revokedAt: number | null;
}

export interface IssuedWebhookTokens {
  readonly bearer: string;
  readonly hmacSecret: string;
}

export class WebhookTokenStore {
  private readonly stmts: ReturnType<WebhookTokenStore["prepare"]>;

  constructor(private readonly db: Database.Database, private readonly encryptionKey: Buffer) {
    if (encryptionKey.length !== 32) throw new Error("WebhookTokenStore encryption key must be 32 bytes");
    this.db.exec(SCHEMA);
    this.stmts = this.prepare();
  }

  issue(watcherId: string): IssuedWebhookTokens {
    const bearer = randomBytes(24).toString("base64url");
    const hmacSecret = randomBytes(24).toString("base64url");
    const bearerHash = sha256Hex(bearer);
    const hmacCipher = encrypt(hmacSecret, this.encryptionKey);
    const now = Date.now();
    const existing = this.stmts.selectByWatcher.get(watcherId) as WebhookTokenRow | undefined;
    if (existing) {
      this.stmts.rotate.run(bearerHash, hmacCipher, now, watcherId);
      log.info({ watcherId }, "webhook tokens rotated");
    } else {
      this.stmts.insert.run(watcherId, bearerHash, hmacCipher, now);
      log.info({ watcherId }, "webhook tokens issued");
    }
    return { bearer, hmacSecret };
  }

  revoke(watcherId: string): boolean {
    return this.stmts.revoke.run(Date.now(), watcherId).changes > 0;
  }

  remove(watcherId: string): void {
    this.stmts.remove.run(watcherId);
  }

  getRow(watcherId: string): WebhookTokenRow | null {
    return (this.stmts.selectByWatcher.get(watcherId) as WebhookTokenRow | undefined) ?? null;
  }

  /** Constant-time bearer check. */
  verifyBearer(watcherId: string, supplied: string): boolean {
    const row = this.getRow(watcherId);
    if (!row || row.revokedAt !== null) return false;
    const a = Buffer.from(sha256Hex(supplied), "hex");
    const b = Buffer.from(row.bearerHash, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** Returns the plaintext HMAC secret for a watcher, or null if absent/revoked. */
  hmacSecretFor(watcherId: string): string | null {
    const row = this.getRow(watcherId);
    if (!row || row.revokedAt !== null) return null;
    try {
      return decrypt(row.hmacCipher, this.encryptionKey);
    } catch (e) {
      log.error({ watcherId, err: (e as Error).message }, "hmac decrypt failed — wrong encryption key?");
      return null;
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private prepare() {
    return {
      insert: this.db.prepare(
        `INSERT INTO webhook_tokens (watcher_id, bearer_hash, hmac_cipher, created_at) VALUES (?, ?, ?, ?)`,
      ),
      rotate: this.db.prepare(
        `UPDATE webhook_tokens SET bearer_hash=?, hmac_cipher=?, rotated_at=?, revoked_at=NULL WHERE watcher_id=?`,
      ),
      revoke: this.db.prepare(
        `UPDATE webhook_tokens SET revoked_at=? WHERE watcher_id=? AND revoked_at IS NULL`,
      ),
      remove: this.db.prepare(`DELETE FROM webhook_tokens WHERE watcher_id=?`),
      selectByWatcher: this.db.prepare(
        `SELECT watcher_id AS watcherId, bearer_hash AS bearerHash, hmac_cipher AS hmacCipher,
                created_at AS createdAt, rotated_at AS rotatedAt, revoked_at AS revokedAt
         FROM webhook_tokens WHERE watcher_id = ?`,
      ),
    };
  }
}

// ── crypto helpers ─────────────────────────────────────────────────────────

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
}

function decrypt(blob: string, key: Buffer): string {
  const parts = blob.split(".");
  if (parts.length !== 3) throw new Error("malformed cipher");
  const [ivB, tagB, ctB] = parts as [string, string, string];
  const iv = Buffer.from(ivB, "base64");
  const tag = Buffer.from(tagB, "base64");
  const ct = Buffer.from(ctB, "base64");
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) throw new Error("malformed cipher");
  const d = createDecipheriv(ALGO, key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf-8");
}
