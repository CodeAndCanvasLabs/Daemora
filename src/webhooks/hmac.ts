/**
 * HMAC webhook signature verifiers — GitHub, Stripe, and a generic one.
 *
 * All three use HMAC-SHA256 but differ in:
 *   - Which header carries the signature
 *   - Whether a timestamp is part of the signed payload (replay defense)
 *   - Encoding (hex vs base64 vs "sha256=<hex>" form)
 *
 * Every verifier uses `timingSafeEqual` on Buffer-of-expected-length to
 * avoid timing attacks. Every verifier returns a structured result so
 * the caller can log the *kind* of failure without logging the signature.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type HmacProvider = "github" | "stripe" | "generic";

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "malformed" | "mismatch" | "stale" };

/**
 * GitHub: `X-Hub-Signature-256: sha256=<hex>` where signature =
 * HMAC-SHA256(secret, rawBody). Hex, lower-case.
 */
export function verifyGithub(rawBody: string, signatureHeader: string | undefined, secret: string): VerifyResult {
  if (!signatureHeader) return { ok: false, reason: "missing" };
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return { ok: false, reason: "malformed" };
  const sigHex = signatureHeader.slice(prefix.length);
  return compareHex(hmacHex(secret, rawBody), sigHex);
}

/**
 * Stripe: `Stripe-Signature: t=<unixTs>,v1=<hex>[,v1=<hex>...]`
 * Signed payload is `${t}.${body}`. Also enforce a timestamp window
 * (default 5 minutes) to defeat replay of captured signatures.
 */
export function verifyStripe(rawBody: string, signatureHeader: string | undefined, secret: string, opts: { toleranceSeconds?: number; now?: number } = {}): VerifyResult {
  if (!signatureHeader) return { ok: false, reason: "missing" };
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  const parts = Object.create(null) as Record<string, string[]>;
  for (const pair of signatureHeader.split(",")) {
    const [k, v] = pair.trim().split("=");
    if (!k || v === undefined) continue;
    (parts[k] ??= []).push(v);
  }
  const tsRaw = parts["t"]?.[0];
  const candidates = parts["v1"] ?? [];
  if (!tsRaw || candidates.length === 0) return { ok: false, reason: "malformed" };
  const ts = Number.parseInt(tsRaw, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: "malformed" };

  if (Math.abs(now - ts) > tolerance) return { ok: false, reason: "stale" };

  const expected = hmacHex(secret, `${ts}.${rawBody}`);
  for (const candidate of candidates) {
    if (constantTimeHexEq(expected, candidate)) return { ok: true };
  }
  return { ok: false, reason: "mismatch" };
}

/**
 * Generic: `X-Webhook-Signature: <hex>` = HMAC-SHA256(secret, rawBody).
 * Optional `X-Webhook-Timestamp: <unix>` enforces replay window when present.
 */
export function verifyGeneric(rawBody: string, signatureHeader: string | undefined, secret: string, opts: { timestampHeader?: string | undefined; toleranceSeconds?: number; now?: number } = {}): VerifyResult {
  if (!signatureHeader) return { ok: false, reason: "missing" };
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (opts.timestampHeader) {
    const ts = Number.parseInt(opts.timestampHeader, 10);
    if (!Number.isFinite(ts)) return { ok: false, reason: "malformed" };
    if (Math.abs(now - ts) > tolerance) return { ok: false, reason: "stale" };
  }
  return compareHex(hmacHex(secret, rawBody), signatureHeader);
}

// ── helpers ────────────────────────────────────────────────────────────────

function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

function compareHex(expected: string, actual: string): VerifyResult {
  if (!/^[0-9a-f]+$/i.test(actual)) return { ok: false, reason: "malformed" };
  if (!constantTimeHexEq(expected, actual)) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

function constantTimeHexEq(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) return false;
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
