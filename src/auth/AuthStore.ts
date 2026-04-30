/**
 * AuthStore — refresh-token persistence + audit trail.
 *
 * Refresh tokens are stored as `sha256(token)` so a DB leak can't be
 * replayed. Rows carry enough metadata to list "active sessions" in
 * the UI (device name, last used, created at) and revoke individually
 * or en masse (on password change).
 *
 * Revocation is soft — `revoked_at` timestamp, never deleted. Keeps
 * audit trail; cleanup is a separate scheduled sweep (not done here).
 */

import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

import { createLogger } from "../util/logger.js";

const log = createLogger("auth.store");

export interface RefreshTokenRow {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly deviceName: string | null;
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly revokedAt: number | null;
  /**
   * Expiry in epoch ms, or `null` for non-expiring. By default we
   * issue non-expiring refreshes — the user revokes them on logout.
   */
  readonly expiresAt: number | null;
}

export interface AuditRow {
  readonly id: string;
  readonly at: number;
  readonly userId: string;
  readonly event: AuditEvent;
  readonly ip: string | null;
  readonly detail: string | null;
}

export type AuditEvent =
  | "login.ok"
  | "login.fail"
  | "refresh.ok"
  | "refresh.reuse"      // attempted use of a rotated/revoked token → security alert
  | "logout"
  | "revoke.all"
  | "issue.webhook-token"
  | "revoke.webhook-token";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,
  device_name     TEXT,
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER NOT NULL,
  revoked_at      INTEGER,
  expires_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_hash ON auth_refresh_tokens(token_hash);

CREATE TABLE IF NOT EXISTS auth_audit (
  id         TEXT PRIMARY KEY,
  at         INTEGER NOT NULL,
  user_id    TEXT NOT NULL,
  event      TEXT NOT NULL,
  ip         TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_audit_at ON auth_audit(at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_audit_user ON auth_audit(user_id);
`;

export class AuthStore {
  private readonly stmts: ReturnType<AuthStore["prepare"]>;

  constructor(private readonly db: Database.Database) {
    this.db.exec(SCHEMA);
    this.stmts = this.prepare();
    log.debug("auth store ready");
  }

  // ── Refresh tokens ─────────────────────────────────────────────────────

  /**
   * Mint a fresh refresh token and persist its hash. Returns the
   * plaintext token (caller gives it to the client; server never
   * sees it again except as a hash).
   */
  issueRefresh(opts: { userId: string; deviceName?: string; expiresAt?: number | null }): { id: string; token: string; row: RefreshTokenRow } {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hash(token);
    const id = randomBytes(12).toString("hex");
    const now = Date.now();
    this.stmts.insertRefresh.run(
      id,
      opts.userId,
      tokenHash,
      opts.deviceName ?? null,
      now,
      now,
      null,
      opts.expiresAt ?? null,
    );
    const row = this.getRefreshById(id)!;
    return { id, token, row };
  }

  /**
   * Look up by plaintext token. Returns null if the token is unknown,
   * revoked, or expired. Marks the row as used on success.
   *
   * NOTE: caller still has to rotate the token (issue new, revoke old)
   * — that's in TokenService to keep the audit path centralised.
   */
  findActiveByToken(token: string): RefreshTokenRow | null {
    const tokenHash = hash(token);
    const row = this.stmts.selectByHash.get(tokenHash) as RefreshTokenRow | undefined;
    if (!row) return null;
    if (row.revokedAt !== null) return null;
    if (row.expiresAt !== null && row.expiresAt <= Date.now()) return null;
    return row;
  }

  markUsed(id: string): void {
    this.stmts.touchUsed.run(Date.now(), id);
  }

  revoke(id: string): boolean {
    const info = this.stmts.revokeOne.run(Date.now(), id);
    return info.changes > 0;
  }

  revokeAllForUser(userId: string): number {
    return this.stmts.revokeUser.run(Date.now(), userId).changes;
  }

  listActiveForUser(userId: string): readonly RefreshTokenRow[] {
    return this.stmts.listActive.all(userId) as RefreshTokenRow[];
  }

  getRefreshById(id: string): RefreshTokenRow | null {
    return (this.stmts.selectById.get(id) as RefreshTokenRow) ?? null;
  }

  // ── Audit ──────────────────────────────────────────────────────────────

  audit(entry: { userId: string; event: AuditEvent; ip?: string | null; detail?: string | null }): void {
    this.stmts.insertAudit.run(
      randomBytes(8).toString("hex"),
      Date.now(),
      entry.userId,
      entry.event,
      entry.ip ?? null,
      entry.detail ?? null,
    );
  }

  listAudit(opts: { userId?: string; limit?: number } = {}): readonly AuditRow[] {
    const limit = Math.min(opts.limit ?? 100, 500);
    if (opts.userId) return this.stmts.auditByUser.all(opts.userId, limit) as AuditRow[];
    return this.stmts.auditAll.all(limit) as AuditRow[];
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private prepare() {
    return {
      insertRefresh: this.db.prepare(
        `INSERT INTO auth_refresh_tokens (id, user_id, token_hash, device_name, created_at, last_used_at, revoked_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      selectByHash: this.db.prepare(
        `SELECT id, user_id AS userId, token_hash AS tokenHash, device_name AS deviceName,
                created_at AS createdAt, last_used_at AS lastUsedAt,
                revoked_at AS revokedAt, expires_at AS expiresAt
         FROM auth_refresh_tokens WHERE token_hash = ?`,
      ),
      selectById: this.db.prepare(
        `SELECT id, user_id AS userId, token_hash AS tokenHash, device_name AS deviceName,
                created_at AS createdAt, last_used_at AS lastUsedAt,
                revoked_at AS revokedAt, expires_at AS expiresAt
         FROM auth_refresh_tokens WHERE id = ?`,
      ),
      listActive: this.db.prepare(
        `SELECT id, user_id AS userId, token_hash AS tokenHash, device_name AS deviceName,
                created_at AS createdAt, last_used_at AS lastUsedAt,
                revoked_at AS revokedAt, expires_at AS expiresAt
         FROM auth_refresh_tokens
         WHERE user_id = ? AND revoked_at IS NULL
         ORDER BY last_used_at DESC`,
      ),
      touchUsed: this.db.prepare(
        `UPDATE auth_refresh_tokens SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL`,
      ),
      revokeOne: this.db.prepare(
        `UPDATE auth_refresh_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
      ),
      revokeUser: this.db.prepare(
        `UPDATE auth_refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
      ),
      insertAudit: this.db.prepare(
        `INSERT INTO auth_audit (id, at, user_id, event, ip, detail) VALUES (?, ?, ?, ?, ?, ?)`,
      ),
      auditByUser: this.db.prepare(
        `SELECT id, at, user_id AS userId, event, ip, detail FROM auth_audit WHERE user_id = ? ORDER BY at DESC LIMIT ?`,
      ),
      auditAll: this.db.prepare(
        `SELECT id, at, user_id AS userId, event, ip, detail FROM auth_audit ORDER BY at DESC LIMIT ?`,
      ),
    };
  }
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
