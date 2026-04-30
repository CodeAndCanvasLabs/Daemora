/**
 * /api/channels — list, status, start/stop, config.
 */

import type { Express, Request, Response } from "express";

import type { ServerDeps } from "../index.js";

export function mountChannelRoutes(app: Express, deps: ServerDeps): void {
  app.get("/api/channels", (_req, res) => {
    const status = deps.channels.list();
    const running = deps.channelManager.runningSet();
    const defs = deps.channels.defs();
    const defById = new Map(defs.map((d) => [d.id, d]));
    res.json({
      channels: status.map((s) => {
        const def = defById.get(s.id);
        return {
          ...s,
          running: running.has(s.id),
          description: def?.description ?? "",
          icon: def?.icon ?? "",
          implemented: def?.implemented ?? false,
          requiredKeys: def?.requiredKeys ?? [],
        };
      }),
    });
  });

  app.get("/api/channels/defs", (_req, res) => {
    res.json({ defs: deps.channels.defs() });
  });

  app.get("/api/channels/:id", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const def = deps.channels.defs().find((d) => d.id === id);
    if (!def) return res.status(404).json({ error: "channel not found" });
    const running = deps.channelManager.runningSet().has(id);
    res.json({ def, running });
  });

  app.post("/api/channels/:id/start", async (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    // Use targeted start(id) — startAll() would iterate every def and
    // factory-create duplicate instances of channels that are already
    // running, causing e.g. Telegram 409 "Conflict: terminated by other
    // getUpdates request" when the same bot token is polled twice.
    const started = await deps.channelManager.start(id);
    if (!started) {
      return res.status(400).json({
        error: "channel not startable — missing config or not implemented",
      });
    }
    res.json({ ok: true, running: deps.channelManager.runningSet().has(id) });
  });

  app.post("/api/channels/:id/stop", async (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const stopped = await deps.channelManager.stop(id);
    if (!stopped) return res.status(404).json({ error: "channel not running" });
    res.json({ ok: true });
  });

  app.post("/api/channels/reload", async (_req, res) => {
    await deps.channelManager.stopAll();
    await deps.channelManager.startAll();
    res.json({ ok: true, running: Array.from(deps.channelManager.runningSet()) });
  });

  /**
   * Remove a channel's configuration: stop it if running, then wipe
   * every declared secret key from the vault. The channel def itself
   * stays available in the registry so the user can reconfigure later.
   */
  app.delete("/api/channels/:id", async (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const def = deps.channels.defs().find((d) => d.id === id);
    if (!def) return res.status(404).json({ error: "channel not found" });

    if (deps.channelManager.runningSet().has(id)) {
      try { await deps.channelManager.stop(id); } catch {}
    }

    const cleared: string[] = [];
    if (deps.cfg.vault.isUnlocked()) {
      for (const rk of def.requiredKeys ?? []) {
        const key = rk.key;
        if (deps.cfg.vault.has(key)) {
          deps.cfg.vault.delete(key);
          cleared.push(key);
        }
      }
    }
    res.json({ ok: true, cleared, vaultLocked: !deps.cfg.vault.isUnlocked() });
  });
}
