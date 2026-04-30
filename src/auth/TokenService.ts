/**
 * TokenService — issues access + refresh tokens, rotates refresh on
 * use, verifies access tokens, centralises the audit trail.
 *
 * Access tokens (JWT HS256):
 *   - Short-lived (24 h default). Stateless — verification is signature
 *     + expiry; no DB hit.
 *   - Claims: sub, plan, scopes, iat, exp, deviceName.
 *
 * Refresh tokens (opaque, 32 B, random):
 *   - Long-lived / non-expiring by default. Stored as sha256 hash.
 *   - Rotated on use: every /auth/refresh invalidates the old token
 *     and returns a fresh one. Replay of a used token → "refresh.reuse"
 *     audit entry + revoke-all-for-user (defense in depth: if an
 *     attacker stole a refresh token and the real user has already
 *     rotated, we detect the double-use and kill the whole session set).
 *
 * Signing key:
 *   - Passed in at construction. The caller (auth factory) derives it
 *     per deploy mode — HKDF from vault locally, env-injected in cloud.
 *   - Rotating the key invalidates every outstanding access token.
 *     Refresh tokens survive (they're opaque, not signed) so clients
 *     transparently get new access tokens on next refresh.
 */

import type { AuthStore, AuditEvent } from "./AuthStore.js";
import type { AuthenticatedUser } from "./AuthProvider.js";
import { signJwt, verifyJwt, type JwtClaims, type VerifyResult } from "./jwt.js";

const ACCESS_TTL_SECONDS = 24 * 60 * 60; // 24h
const REFRESH_REUSE_WINDOW_MS = 5_000;   // grace period for legit network retries

export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: number; // epoch ms
  readonly refreshId: string;
  readonly user: AuthenticatedUser;
}

export interface TokenServiceOptions {
  /** HMAC key for JWT HS256 sign/verify. */
  readonly signingKey: Buffer | string;
  /** Override access-token TTL in seconds (default 24h). */
  readonly accessTtlSeconds?: number;
  /** Device name to tag the refresh token with (for the UI session list). */
  readonly defaultDeviceName?: string;
}

export class TokenService {
  private readonly signingKey: Buffer | string;
  private readonly accessTtl: number;

  constructor(
    private readonly store: AuthStore,
    opts: TokenServiceOptions,
  ) {
    this.signingKey = opts.signingKey;
    this.accessTtl = opts.accessTtlSeconds ?? ACCESS_TTL_SECONDS;
  }

  /**
   * Called by /auth/login after AuthProvider verified credentials.
   * Issues a fresh refresh + access pair. Passes `deviceName` so the
   * user can distinguish devices in the session list later.
   */
  issueForUser(user: AuthenticatedUser, opts: { deviceName?: string; ip?: string | null } = {}): IssuedTokens {
    const refresh = this.store.issueRefresh({ userId: user.id, ...(opts.deviceName ? { deviceName: opts.deviceName } : {}) });
    const tokens = this.mintAccess(user, refresh.id, opts.deviceName);
    this.audit(user.id, "login.ok", opts.ip ?? null, opts.deviceName);
    return { ...tokens, refreshToken: refresh.token, refreshId: refresh.id, user };
  }

  /**
   * Called by /auth/refresh. Rotates the refresh token (invalidates
   * old, issues new) and mints a fresh access token.
   *
   * `provider` lets us re-resolve the user's current plan/scopes —
   * refresh shouldn't snapshot stale tier info if the user's plan
   * changed since the last login.
   */
  rotateRefresh(
    refreshToken: string,
    resolveUser: (userId: string) => AuthenticatedUser | null,
    opts: { deviceName?: string; ip?: string | null } = {},
  ): IssuedTokens | { failure: "unknown" | "reused" } {
    const row = this.store.findActiveByToken(refreshToken);
    if (!row) {
      // Token doesn't exist or was already revoked → possible reuse.
      // We can't know whose session to kill without a lookup that
      // doesn't exist here (the hash is the only identifier), so the
      // best we can do is audit a generic reuse event and refuse.
      this.audit("unknown", "refresh.reuse", opts.ip ?? null, `token prefix=${refreshToken.slice(0, 6)}`);
      return { failure: "reused" };
    }

    const user = resolveUser(row.userId);
    if (!user) {
      this.store.revoke(row.id);
      return { failure: "unknown" };
    }

    // Grace period: don't rotate if the same refresh was just rotated
    // a couple seconds ago (retry after a dropped connection).
    const tooRecent = Date.now() - row.lastUsedAt < REFRESH_REUSE_WINDOW_MS && row.lastUsedAt !== row.createdAt;
    if (tooRecent) {
      this.store.markUsed(row.id);
      const access = this.mintAccess(user, row.id, row.deviceName ?? undefined);
      return { ...access, refreshToken, refreshId: row.id, user };
    }

    // Rotate: revoke current, issue new, bind to the same user+device.
    this.store.revoke(row.id);
    const newRow = this.store.issueRefresh({ userId: user.id, ...(row.deviceName ? { deviceName: row.deviceName } : {}) });
    const access = this.mintAccess(user, newRow.id, row.deviceName ?? undefined);
    this.audit(user.id, "refresh.ok", opts.ip ?? null);
    return { ...access, refreshToken: newRow.token, refreshId: newRow.id, user };
  }

  /**
   * Revoke a single refresh token (sign-out this device). Called by
   * /auth/logout.
   */
  logout(refreshToken: string, ip?: string | null): boolean {
    const row = this.store.findActiveByToken(refreshToken);
    if (!row) return false;
    this.store.revoke(row.id);
    this.audit(row.userId, "logout", ip ?? null);
    return true;
  }

  /** Revoke every session for a user (called on passphrase rotation). */
  logoutAll(userId: string, ip?: string | null): number {
    const n = this.store.revokeAllForUser(userId);
    this.audit(userId, "revoke.all", ip ?? null, `count=${n}`);
    return n;
  }

  /** Verify an access token. Fast path — no DB hit. */
  verifyAccess(token: string): VerifyResult {
    return verifyJwt(token, this.signingKey);
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private mintAccess(user: AuthenticatedUser, refreshId: string, deviceName: string | undefined): Omit<IssuedTokens, "refreshToken" | "refreshId" | "user"> {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + this.accessTtl;
    const claims: JwtClaims = {
      sub: user.id,
      iat: now,
      exp,
      scopes: user.scopes,
      rid: refreshId,       // pair access ↔ refresh row for audit correlation
      ...(deviceName ? { deviceName } : {}),
    };
    return {
      accessToken: signJwt(claims, this.signingKey),
      accessExpiresAt: exp * 1000,
    };
  }

  private audit(userId: string, event: AuditEvent, ip: string | null, detail?: string): void {
    this.store.audit({ userId, event, ip, ...(detail ? { detail } : {}) });
  }
}
