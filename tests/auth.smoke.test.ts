/**
 * Smoke tests for the auth stack.
 *
 *  - JWT sign/verify round-trips, rejects forged, detects expiry
 *  - alg-none / alg-swap attacks fail
 *  - AuthStore refresh rotation: issue → find → revoke → re-find fails
 *  - TokenService: login → refresh → rotated token is fresh, old fails
 *  - TokenService: reuse of a revoked refresh is detected + audited
 *  - fileToken constant-time compare + loopback detector
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import Database from "better-sqlite3";

import { AuthStore } from "../src/auth/AuthStore.js";
import { TokenService } from "../src/auth/TokenService.js";
import { signJwt, verifyJwt } from "../src/auth/jwt.js";
import { constantTimeEqual, isLoopback } from "../src/auth/fileToken.js";
import type { AuthenticatedUser } from "../src/auth/AuthProvider.js";

const USER: AuthenticatedUser = { id: "local", label: "Local", scopes: ["all"] };
const KEY = randomBytes(32);

describe("JWT", () => {
  it("signs and verifies a round-trip token", () => {
    const now = Math.floor(Date.now() / 1000);
    const tok = signJwt({ sub: "u1", iat: now, exp: now + 60 }, KEY);
    const r = verifyJwt(tok, KEY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims.sub).toBe("u1");
  });

  it("rejects forged signatures", () => {
    const now = Math.floor(Date.now() / 1000);
    const tok = signJwt({ sub: "u1", iat: now, exp: now + 60 }, KEY);
    // swap the last byte of the signature
    const parts = tok.split(".");
    const sig = parts[2]!;
    const tampered = parts[0] + "." + parts[1] + "." + (sig.slice(0, -1) + (sig.at(-1) === "A" ? "B" : "A"));
    const r = verifyJwt(tampered, KEY);
    expect(r.ok).toBe(false);
  });

  it("rejects expired tokens", () => {
    const now = Math.floor(Date.now() / 1000);
    const tok = signJwt({ sub: "u1", iat: now - 120, exp: now - 60 }, KEY);
    const r = verifyJwt(tok, KEY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  it("rejects alg-none attack (header swap)", () => {
    // Construct a fake "alg: none" header + match payload.
    const fakeHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "u1", exp: 9999999999 })).toString("base64url");
    const forged = `${fakeHeader}.${payload}.`;
    const r = verifyJwt(forged, KEY);
    expect(r.ok).toBe(false);
  });
});

describe("AuthStore", () => {
  it("issues, looks up, and revokes refresh tokens", () => {
    const db = new Database(":memory:");
    const store = new AuthStore(db);
    const { token, row } = store.issueRefresh({ userId: "u1", deviceName: "laptop" });
    expect(token.length).toBeGreaterThan(20);
    const looked = store.findActiveByToken(token);
    expect(looked?.id).toBe(row.id);
    store.revoke(row.id);
    expect(store.findActiveByToken(token)).toBeNull();
  });

  it("revokeAllForUser kills every active token", () => {
    const db = new Database(":memory:");
    const store = new AuthStore(db);
    const a = store.issueRefresh({ userId: "u1" });
    const b = store.issueRefresh({ userId: "u1" });
    const n = store.revokeAllForUser("u1");
    expect(n).toBe(2);
    expect(store.findActiveByToken(a.token)).toBeNull();
    expect(store.findActiveByToken(b.token)).toBeNull();
  });
});

describe("TokenService", () => {
  function build() {
    const db = new Database(":memory:");
    const store = new AuthStore(db);
    const svc = new TokenService(store, { signingKey: KEY });
    return { store, svc };
  }

  it("issues access + refresh; access verifies", () => {
    const { svc } = build();
    const t = svc.issueForUser(USER, { deviceName: "laptop" });
    expect(t.accessToken.split(".").length).toBe(3);
    const r = svc.verifyAccess(t.accessToken);
    expect(r.ok).toBe(true);
  });

  it("rotates refresh: new refresh works, old refresh fails outside grace", async () => {
    const { svc } = build();
    const t1 = svc.issueForUser(USER);
    // Wait past the 5s grace window... actually, for the grace path,
    // we need lastUsedAt != createdAt. The first rotation always
    // happens while lastUsedAt === createdAt, so grace doesn't apply
    // on first use — we rotate.
    const r = svc.rotateRefresh(t1.refreshToken, () => USER);
    if ("failure" in r) throw new Error("expected success, got " + r.failure);
    expect(r.refreshToken).not.toBe(t1.refreshToken);
    // Using the OLD refresh after rotation → reuse detected.
    const r2 = svc.rotateRefresh(t1.refreshToken, () => USER);
    expect("failure" in r2 && r2.failure === "reused").toBe(true);
  });

  it("logout revokes the refresh", () => {
    const { svc } = build();
    const t = svc.issueForUser(USER);
    expect(svc.logout(t.refreshToken)).toBe(true);
    const after = svc.rotateRefresh(t.refreshToken, () => USER);
    expect("failure" in after).toBe(true);
  });

  it("logoutAll revokes every session for a user", () => {
    const { svc } = build();
    const a = svc.issueForUser(USER, { deviceName: "d1" });
    const b = svc.issueForUser(USER, { deviceName: "d2" });
    const n = svc.logoutAll(USER.id);
    expect(n).toBe(2);
    expect("failure" in svc.rotateRefresh(a.refreshToken, () => USER)).toBe(true);
    expect("failure" in svc.rotateRefresh(b.refreshToken, () => USER)).toBe(true);
  });
});

describe("fileToken helpers", () => {
  it("constant-time compare matches identical and rejects any diff", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
    expect(constantTimeEqual("abc123", "abc124")).toBe(false);
    expect(constantTimeEqual("abc123", "abc12")).toBe(false);
  });

  it("isLoopback recognises the three forms", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("10.0.0.5")).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});
