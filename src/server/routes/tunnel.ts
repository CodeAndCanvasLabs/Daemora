/**
 * Tunnel status endpoint for the UI.
 *
 *   GET /api/tunnel → { url, kind }
 *
 * Read-only surface so the Settings / Watchers page can show the user
 * the currently active public URL and what provider sourced it.
 */

import type { Express } from "express";

import type { TunnelManager } from "../../tunnels/TunnelManager.js";

export function mountTunnelRoutes(app: Express, tunnel: TunnelManager, getPublicUrl: () => string): void {
  app.get("/api/tunnel", (_req, res) => {
    const current = tunnel.current();
    res.json({
      url: getPublicUrl(),
      kind: current.kind,
    });
  });
}
