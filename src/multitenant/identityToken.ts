/**
 * Signed gateway→tenant identity token.
 *
 * The single-ingress gateway authenticates the user, then injects an
 * `X-Daemora-User` header carrying a short-lived HMAC token. The tenant
 * verifies it so it trusts ONLY the gateway — even on a shared private
 * network nothing else can impersonate the gateway and address a tenant.
 *
 * Token format: `<userId>.<slug>.<exp>.<sig>` where
 *   sig = base64url(HMAC-SHA256(secret, "<userId>.<slug>.<exp>"))
 * userId (uuid), slug (DNS-safe), exp (unix seconds), sig (base64url) all
 * contain no `.`, so a 4-part split is unambiguous.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_SEC = 60;

export function signIdentity(
  secret: string,
  userId: string,
  slug: string,
  opts: { ttlSec?: number; nowMs?: number } = {},
): string {
  const nowMs = opts.nowMs ?? Date.now();
  const exp = Math.floor(nowMs / 1000) + (opts.ttlSec ?? DEFAULT_TTL_SEC);
  const payload = `${userId}.${slug}.${exp}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export interface VerifiedIdentity {
  readonly userId: string;
  readonly slug: string;
}

/** Returns the verified identity, or null if malformed / bad signature / expired. */
export function verifyIdentity(secret: string, token: string, nowMs = Date.now()): VerifiedIdentity | null {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [userId, slug, expStr, sig] = parts as [string, string, string, string];
  if (!userId || !slug || !expStr || !sig) return null;

  const expected = createHmac("sha256", secret).update(`${userId}.${slug}.${expStr}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp * 1000 < nowMs) return null; // expired

  return { userId, slug };
}
