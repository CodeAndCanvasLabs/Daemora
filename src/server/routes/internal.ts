/**
 * /internal/* — gateway→tenant internal API (NOT user-facing).
 *
 * POST /internal/config — the gateway pushes a central (Postgres) config change
 * so it applies LIVE on the running tenant, no restart. Most settings are read
 * fresh per use (e.g. DEFAULT_MODEL via cfg.setting), so writing them into the
 * local SettingsStore is enough to take effect immediately.
 *
 * Security: mounted ONLY when INTERNAL_SIGNING_SECRET is set, and the global
 * gateway-identity gate already requires a valid signed `X-Daemora-User` for
 * every non-/health path — so only the gateway can reach this. Secrets never
 * travel this channel (they use the encrypted vault path).
 */

import type { Express, Request, Response } from "express";

import type { ServerDeps } from "../index.js";
import { createLogger } from "../../util/logger.js";

const log = createLogger("server.internal");

export function mountInternalRoutes(app: Express, deps: ServerDeps): void {
  app.post("/internal/config", (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    let applied = 0;
    for (const [key, value] of Object.entries(body)) {
      deps.cfg.settings.setGeneric(key, value);
      applied++;
    }
    log.info({ applied }, "central config applied live from gateway");
    res.json({ ok: true, applied });
  });
}
