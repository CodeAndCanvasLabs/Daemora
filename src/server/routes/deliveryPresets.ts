/**
 * Delivery presets REST — CRUD for named channel groups reused by
 * cron jobs / watchers.
 *
 *   GET    /api/delivery-presets        list
 *   POST   /api/delivery-presets        create/update
 *   GET    /api/delivery-presets/:id    fetch
 *   DELETE /api/delivery-presets/:id    remove
 */

import type { Express, Request, Response } from "express";

import type { DeliveryPresetStore } from "../../scheduler/DeliveryPresetStore.js";

export function mountDeliveryPresetRoutes(app: Express, store: DeliveryPresetStore): void {
  app.get("/api/delivery-presets", (_req, res) => {
    res.json({ presets: store.list() });
  });

  app.post("/api/delivery-presets", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      id?: string;
      name?: string;
      description?: string;
      targets?: Array<{ channel?: string; channelMeta?: Record<string, unknown> | null }>;
    };
    if (!body.name) return res.status(400).json({ error: "`name` is required" });
    const targets = Array.isArray(body.targets)
      ? body.targets.filter((t) => typeof t.channel === "string").map((t) => ({ channel: t.channel!, channelMeta: t.channelMeta ?? null }))
      : [];
    const preset = store.save({
      ...(body.id ? { id: body.id } : {}),
      name: body.name,
      description: body.description ?? null,
      targets,
    });
    res.status(201).json({ preset });
  });

  app.get("/api/delivery-presets/:id", (req, res) => {
    const preset = store.get(req.params.id ?? "");
    if (!preset) return res.status(404).json({ error: "Not found" });
    res.json({ preset });
  });

  app.delete("/api/delivery-presets/:id", (req, res) => {
    const ok = store.delete(req.params.id ?? "");
    if (!ok) return res.status(404).json({ error: "Not found" });
    res.status(204).end();
  });
}
