/**
 * Security middleware — headers + CORS + rate limit + exponential backoff.
 *
 * Headers (applied to every response):
 *   X-Content-Type-Options   : nosniff
 *   X-Frame-Options          : DENY
 *   Referrer-Policy          : no-referrer
 *   Content-Security-Policy  : tight — only self + data: images + inline
 *                              styles (the UI bundles inline styles).
 *                              Script-src is 'self' only — no eval, no CDN.
 *   Strict-Transport-Security: max-age=31536000; includeSubDomains
 *                              (only emitted when the request arrived
 *                              over HTTPS, via X-Forwarded-Proto or the
 *                              socket's tls flag — never asserted on
 *                              plain http to avoid breaking loopback)
 *
 * CORS (for /api/* and /auth/*):
 *   - Same-origin + loopback by default
 *   - Additional allowed origins via `CORS_ALLOW_ORIGINS` (comma list)
 *   - Credentials: true (needed for httpOnly refresh cookie)
 *   - OPTIONS preflight: 204 with the allow-* headers
 *
 * Rate limit (per IP):
 *   - Exposed as a middleware factory: `rateLimit({ max, windowMs })`
 *   - Exponential backoff variant for /auth/login specifically: after
 *     N consecutive failures from the same IP, reject with 429 and a
 *     Retry-After header for 2^N seconds (capped at 1h).
 */

import type { NextFunction, Request, Response } from "express";

// ── Security headers ───────────────────────────────────────────────────────

function buildCsp(extraConnectSrc: readonly string[]): string {
  const connect = ["'self'", ...extraConnectSrc].filter(Boolean).join(" ");
  const media = ["'self'", "blob:", ...extraConnectSrc].filter(Boolean).join(" ");
  return [
    "default-src 'self'",
    "script-src 'self'",
    // UI bundle (Vite React) ships some inline styles. `'unsafe-inline'`
    // for styles alone is the industry-common trade-off — inline styles
    // can't exfiltrate data the way inline scripts can.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    `media-src ${media}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export interface SecurityHeadersOpts {
  /**
   * Called per-request to return the list of extra origins the page is
   * allowed to open connections to (WebSockets, fetch, etc.). Used for
   * LiveKit — the browser's voice room is a separate origin from the
   * API server, so CSP has to permit it explicitly.
   */
  readonly extraConnectOrigins?: () => readonly string[];
}

/**
 * Default security headers middleware (for callers that don't need
 * dynamic CSP). Retained as a convenience; production code goes
 * through `createSecurityHeaders` so runtime values like LIVEKIT_URL
 * can be reflected in the CSP.
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", buildCsp([]));
  const proto = req.headers["x-forwarded-proto"];
  if (proto === "https" || (req.socket as unknown as { encrypted?: boolean }).encrypted === true) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

export function createSecurityHeaders(opts: SecurityHeadersOpts = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    const extras = opts.extraConnectOrigins ? opts.extraConnectOrigins() : [];
    res.setHeader("Content-Security-Policy", buildCsp(extras));
    const proto = req.headers["x-forwarded-proto"];
    if (proto === "https" || (req.socket as unknown as { encrypted?: boolean }).encrypted === true) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  };
}

// ── CORS ───────────────────────────────────────────────────────────────────

export interface CorsOpts {
  /** Explicit allow-list; `*` wildcards are NOT allowed (would break credentialed CORS). */
  readonly allowedOrigins?: readonly string[];
}

export function cors(opts: CorsOpts = {}) {
  const explicit = new Set(opts.allowedOrigins ?? []);
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (typeof origin === "string") {
      const url = safeParseUrl(origin);
      const host = url?.hostname ?? "";
      const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1";
      if (explicit.has(origin) || isLocal) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Auth-Token");
        res.setHeader("Vary", "Origin");
      }
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

function safeParseUrl(s: string): URL | null {
  try { return new URL(s); } catch { return null; }
}

// ── Rate limiting ──────────────────────────────────────────────────────────

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOpts {
  readonly max: number;
  readonly windowMs: number;
  /** Key extractor. Default: peer IP (socket.remoteAddress, not XFF). */
  readonly keyFn?: (req: Request) => string;
}

/**
 * Fixed-window per-IP rate limit. In-memory; sufficient for a
 * self-hosted single-process agent. Multi-instance deploys should
 * swap this for Redis.
 */
export function rateLimit(opts: RateLimitOpts) {
  const buckets = new Map<string, Bucket>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = opts.keyFn?.(req) ?? (req.socket.remoteAddress ?? "unknown");
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    res.setHeader("X-RateLimit-Limit", String(opts.max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, opts.max - bucket.count)));
    if (bucket.count > opts.max) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      res.status(429).json({ error: "Too many requests", code: "rate_limited" });
      return;
    }
    next();
  };
}

// ── Login failure backoff ─────────────────────────────────────────────────

/**
 * Exponential backoff per IP for login failures. Each consecutive
 * failure doubles the lockout. Resets on success via `recordSuccess`.
 *
 * Usage:
 *   const backoff = loginBackoff();
 *   app.post("/auth/login", backoff.middleware, async (req, res) => {
 *     const ok = await verify(...);
 *     if (!ok) return backoff.recordFailure(req, res);
 *     backoff.recordSuccess(req);
 *     ...
 *   });
 */
export interface LoginBackoff {
  middleware(req: Request, res: Response, next: NextFunction): void;
  recordFailure(req: Request, res: Response): void;
  recordSuccess(req: Request): void;
}

const INITIAL_BACKOFF_SECONDS = 1;
const MAX_BACKOFF_SECONDS = 60 * 60;

export function loginBackoff(): LoginBackoff {
  const state = new Map<string, { failures: number; lockedUntil: number }>();

  const keyOf = (req: Request): string => req.socket.remoteAddress ?? "unknown";

  return {
    middleware(req, res, next) {
      const key = keyOf(req);
      const entry = state.get(key);
      if (!entry) return next();
      const now = Date.now();
      if (entry.lockedUntil > now) {
        res.setHeader("Retry-After", String(Math.ceil((entry.lockedUntil - now) / 1000)));
        res.status(429).json({ error: "Too many failures. Try again later.", code: "login_locked" });
        return;
      }
      next();
    },
    recordFailure(req, res) {
      const key = keyOf(req);
      const entry = state.get(key) ?? { failures: 0, lockedUntil: 0 };
      entry.failures++;
      const wait = Math.min(MAX_BACKOFF_SECONDS, INITIAL_BACKOFF_SECONDS * Math.pow(2, entry.failures - 1));
      entry.lockedUntil = Date.now() + wait * 1000;
      state.set(key, entry);
      res.setHeader("Retry-After", String(wait));
      res.status(401).json({ error: "Invalid credentials", code: "bad_credentials" });
    },
    recordSuccess(req) {
      state.delete(keyOf(req));
    },
  };
}
