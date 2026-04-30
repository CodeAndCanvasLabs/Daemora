/**
 * Auth routes — vault unlock/lock only. No JWT sessions.
 *
 *   POST /auth/login    { passphrase } → { unlocked: true }
 *                       Unlocks the vault for the remainder of this
 *                       process's lifetime. On invalid passphrase,
 *                       responds 401 with rate-limit backoff.
 *
 *   POST /auth/logout   Locks the vault. Any subsequent call that
 *                       needs a secret returns 423 until unlock.
 *
 *   GET  /auth/session  → { unlocked, exists, loopback }
 *                       The UI checks this on boot to decide whether
 *                       to render the unlock modal or the app proper.
 *
 * Daemora is single-tenant. There are no user accounts, no refresh
 * tokens, no session rotation. The only credential is the machine's
 * vault passphrase; once supplied, the vault stays unlocked until the
 * process ends (or you POST /auth/logout).
 */

import type { Express, Request, Response } from "express";

import type { Auth } from "../../auth/index.js";
import { loginBackoff, rateLimit } from "../middleware/security.js";

export function mountAuthRoutes(app: Express, auth: Auth): void {
  const backoff = loginBackoff();
  const loginLimit = rateLimit({ max: 20, windowMs: 60_000 });

  app.post("/auth/login", loginLimit, backoff.middleware, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { passphrase?: unknown };
    const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
    if (!passphrase) return backoff.recordFailure(req, res);

    try {
      const user = await auth.provider.verifyCredentials({ passphrase });
      if (!user) {
        auth.store.audit({ userId: "unknown", event: "login.fail", ip: peerIp(req) });
        return backoff.recordFailure(req, res);
      }
      backoff.recordSuccess(req);
      auth.store.audit({ userId: user.id, event: "login.ok", ip: peerIp(req) });
      res.json({ unlocked: true });
    } catch (e) {
      auth.store.audit({ userId: "unknown", event: "login.fail", ip: peerIp(req), detail: (e as Error).message });
      backoff.recordFailure(req, res);
    }
  });

  app.post("/auth/logout", (req: Request, res: Response) => {
    // Vault stays unlocked for the lifetime of the process — locking
    // it here would break the background token refresher and force
    // every channel/integration to redo OAuth on the next call. We
    // still record the audit event so a future "clear browser session
    // only" semantic stays observable.
    auth.store.audit({ userId: "local", event: "logout", ip: peerIp(req) });
    res.json({ ok: true });
  });

  app.get("/auth/session", (req: Request, res: Response) => {
    res.json({
      unlocked: auth.provider.isUnlocked(),
      exists: auth.provider.exists(),
      loopback: req.auth?.loopback ?? false,
    });
  });
}

function peerIp(req: Request): string {
  return req.socket.remoteAddress ?? "unknown";
}
