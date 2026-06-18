/**
 * Security middleware bundle for apps/api.
 *
 *  - secureHeaders   — CSP, HSTS (prod only), X-Frame-Options, etc.
 *  - rateLimit       — per-IP throttle on auth-sensitive routes
 *  - requireAdmin    — gate based on `users.isAdmin`, not a static bearer
 */

import { secureHeaders } from "hono/secure-headers";
import { rateLimiter } from "hono-rate-limiter";
import type { Context, Next, MiddlewareHandler } from "hono";

import type { Auth } from "../auth/auth.js";

export function buildSecureHeaders(isProd: boolean): MiddlewareHandler {
  return secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https:"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
    strictTransportSecurity: isProd
      ? "max-age=63072000; includeSubDomains; preload"
      : false,
    xFrameOptions: "DENY",
    referrerPolicy: "strict-origin-when-cross-origin",
    xContentTypeOptions: "nosniff",
    permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
  });
}

/** Pull a stable per-caller key — Fly client IP, X-Forwarded-For, or peer. */
function keyForRequest(c: Context): string {
  return (
    c.req.header("fly-client-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown"
  );
}

/** 5 attempts / 10 min — tight enough to block credential stuffing, loose enough for normal users. */
export const authRateLimit = rateLimiter({
  windowMs: 10 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  keyGenerator: keyForRequest,
  message: { error: "rate_limited", detail: "Too many attempts. Try again in a few minutes." },
});

/** Looser limit for read endpoints. */
export const readRateLimit = rateLimiter({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  keyGenerator: keyForRequest,
  message: { error: "rate_limited" },
});

/**
 * Admin-only middleware. Reads session via Better Auth, then 403s if
 * `users.isAdmin` is false. Replaces the static-bearer pattern.
 */
export function requireAdmin(auth: Auth): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return c.json({ error: "unauthorized" }, 401);
    const user = session.user as { id: string; isAdmin?: boolean | null };
    if (!user.isAdmin) return c.json({ error: "forbidden" }, 403);
    c.set("user", user);
    return next();
  };
}
