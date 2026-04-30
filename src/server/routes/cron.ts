/**
 * /api/cron/jobs — cron job CRUD + run history + manual fire.
 *
 * Delivery presets live at /api/cron/presets/* (mountDeliveryPresetRoutes).
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";

import { ValidationError } from "../../util/errors.js";
import type { ServerDeps } from "../index.js";

const deliverySchema = z.object({
  channel: z.string().min(1),
  target: z.record(z.string(), z.unknown()),
}).optional();

const createSchema = z.object({
  name: z.string().min(1).max(120),
  expression: z.string().min(1).max(200),
  task: z.string().min(1).max(4000),
  timezone: z.string().max(64).optional(),
  enabled: z.boolean().default(true),
  delivery: deliverySchema,
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  expression: z.string().min(1).max(200).optional(),
  task: z.string().min(1).max(4000).optional(),
  timezone: z.string().max(64).optional(),
  enabled: z.boolean().optional(),
  delivery: deliverySchema,
});

export function mountCronRoutes(app: Express, deps: ServerDeps): void {
  app.get("/api/cron/jobs", (_req, res) => {
    res.json({ jobs: deps.cron.listJobs() });
  });

  app.get("/api/cron/jobs/:id", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const job = deps.cron.getJob(id);
    if (!job) return res.status(404).json({ error: "job not found" });
    const runs = deps.cron.getJobRuns(id, 50);
    res.json({ job, runs });
  });

  app.post("/api/cron/jobs", (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    try {
      const opts = {
        name: parsed.data.name,
        expression: parsed.data.expression,
        task: parsed.data.task,
        enabled: parsed.data.enabled,
        ...(parsed.data.timezone ? { timezone: parsed.data.timezone } : {}),
        ...(parsed.data.delivery ? { delivery: parsed.data.delivery } : {}),
      };
      const job = deps.cron.addJob(opts);
      res.status(201).json({ job });
    } catch (e) {
      throw new ValidationError((e as Error).message);
    }
  });

  app.patch("/api/cron/jobs/:id", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    try {
      const updates: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed.data)) {
        if (v !== undefined) updates[k] = v;
      }
      const job = deps.cron.updateJob(id, updates);
      res.json({ job });
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  app.delete("/api/cron/jobs/:id", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const ok = deps.cron.deleteJob(id);
    if (!ok) return res.status(404).json({ error: "job not found" });
    res.status(204).end();
  });

  app.get("/api/cron/jobs/:id/runs", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const limit = Math.min(Number(req.query["limit"] ?? 50), 500);
    res.json({ runs: deps.cron.getJobRuns(id, limit) });
  });
}
