/**
 * requireAuth — gate every protected route behind the loopback file-
 * token. No JWT sessions; there are no user accounts in Daemora, only
 * the vault on this machine.
 *
 * Acceptance:
 *   1. `X-Auth-Token: <token>` loopback file-token — only when the TCP
 *      peer is 127.0.0.1/::1 (X-Forwarded-For ignored).
 *   2. `?token=<token>` query — same rule; used by SSE/EventSource
 *      which can't set headers.
 *   Otherwise → 401.
 *
 * Bypassed paths:
 *   - /health, /api/health — monitoring probes
 *   - /auth/login, /auth/logout — vault unlock/lock flow (no auth required
 *       because they ARE the credential exchange)
 *   - /webhooks/:id — channel webhook ingress (per-channel HMAC)
 *   - /hooks/:watcher — watcher webhook (per-watcher token / HMAC)
 *   - /oauth/:provider/callback — external OAuth redirect landing
 *
 * On success, `req.auth = { userId: "local", scopes: ["all"], loopback: true }`
 * so any remaining scope checks trivially pass. Daemora is single-tenant.
 */

import type { NextFunction, Request, Response } from "express";

import { constantTimeEqual, isLoopback } from "../../auth/fileToken.js";

export interface AuthContext {
  readonly userId: string;
  readonly scopes: readonly string[];
  readonly loopback: boolean;
}

export interface RequireAuthDeps {
  readonly fileToken: string;
  readonly enabled: boolean;
}

const BYPASS_EXACT = new Set<string>([
  "/health", "/api/health",
  "/auth/login", "/auth/logout", "/auth/session",
]);
const BYPASS_PREFIX = ["/webhooks/", "/hooks/", "/oauth/"];

export function requireAuth(deps: RequireAuthDeps) {
  return (req: Request, res: Response, next: NextFunction) => {
    const path = req.path;
    const bypass = BYPASS_EXACT.has(path)
      || BYPASS_PREFIX.some((p) => path.startsWith(p));

    const peer = req.socket.remoteAddress;
    const loopback = isLoopback(peer);
    let identified = false;

    if (loopback) {
      const headerTok = typeof req.headers["x-auth-token"] === "string"
        ? (req.headers["x-auth-token"] as string)
        : null;
      const queryTok = typeof req.query["token"] === "string"
        ? (req.query["token"] as string)
        : null;
      const supplied = headerTok ?? queryTok;
      if (supplied && constantTimeEqual(supplied, deps.fileToken)) {
        req.auth = { userId: "local", scopes: ["all"], loopback: true };
        identified = true;
      }
    }

    if (bypass) return next();
    if (!deps.enabled) return next();
    if (identified) return next();

    res.status(401).json({ error: "Unauthorized", code: "auth_required" });
  };
}

/**
 * Per-route scope guard. With the JWT system gone the local loopback
 * caller always has `all`, so this is effectively a no-op — kept for
 * future scope models and to avoid a wide refactor.
 */
export function requireScope(_scope: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ error: "Unauthorized" });
    return next();
  };
}
