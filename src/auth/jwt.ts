/**
 * Minimal HS256 JWT — sign + verify, no dependency.
 *
 * We only ever issue HS256 tokens (symmetric, server holds the key).
 * No RS256/ES256 code paths keeps the surface tiny and audit-friendly.
 *
 * Format: `<header-b64url>.<payload-b64url>.<sig-b64url>` where the sig
 * is `HMAC-SHA256(header-b64url + "." + payload-b64url, key)`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface JwtClaims {
  readonly sub: string;          // subject (user id)
  readonly iat: number;          // issued at (epoch seconds)
  readonly exp: number;          // expires at (epoch seconds)
  readonly scopes?: readonly string[];
  readonly deviceName?: string;
  readonly [key: string]: unknown;
}

const HEADER = { alg: "HS256", typ: "JWT" } as const;
const HEADER_ENCODED = base64urlEncode(Buffer.from(JSON.stringify(HEADER)));

export function signJwt(payload: JwtClaims, key: Buffer | string): string {
  const payloadEncoded = base64urlEncode(Buffer.from(JSON.stringify(payload)));
  const data = `${HEADER_ENCODED}.${payloadEncoded}`;
  const sig = hmac(data, key);
  return `${data}.${base64urlEncode(sig)}`;
}

export type VerifyResult =
  | { ok: true; claims: JwtClaims }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" | "not-yet-valid" };

export function verifyJwt(token: string, key: Buffer | string, now: number = Math.floor(Date.now() / 1000)): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  // We only accept our exact header (alg pinned to HS256). Defends
  // against the classic "alg: none" / alg-confusion attacks by never
  // trusting whatever the token says.
  if (headerB64 !== HEADER_ENCODED) return { ok: false, reason: "malformed" };

  const expectedSig = hmac(`${headerB64}.${payloadB64}`, key);
  let actualSig: Buffer;
  try { actualSig = Buffer.from(base64urlDecode(sigB64)); } catch { return { ok: false, reason: "malformed" }; }
  if (actualSig.length !== expectedSig.length) return { ok: false, reason: "bad-signature" };
  if (!timingSafeEqual(actualSig, expectedSig)) return { ok: false, reason: "bad-signature" };

  let claims: JwtClaims;
  try {
    const raw = Buffer.from(base64urlDecode(payloadB64)).toString("utf-8");
    claims = JSON.parse(raw) as JwtClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (typeof claims.exp !== "number" || claims.exp <= now) return { ok: false, reason: "expired" };
  if (typeof claims.iat === "number" && claims.iat > now + 60) return { ok: false, reason: "not-yet-valid" };
  return { ok: true, claims };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function hmac(data: string, key: Buffer | string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const padded = s + "=".repeat(pad);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
