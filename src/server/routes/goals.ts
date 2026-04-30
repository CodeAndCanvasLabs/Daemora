/**
 * /api/goals — goal CRUD + manual check trigger.
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";

import { ValidationError } from "../../util/errors.js";
import type { ServerDeps } from "../index.js";

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  checkCron: z.string().max(100).optional(),
});

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  status: z.enum(["active", "completed", "paused", "failed"]).optional(),
  checkCron: z.string().max(100).optional(),
  progress: z.number().min(0).max(100).optional(),
  notes: z.string().max(8000).optional(),
});

export function mountGoalRoutes(app: Express, deps: ServerDeps): void {
  app.get("/api/goals", (_req, res) => {
    res.json({ goals: deps.goals.list() });
  });

  app.get("/api/goals/:id", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const goal = deps.goals.get(id);
    if (!goal) return res.status(404).json({ error: "goal not found" });
    res.json({ goal });
  });

  app.post("/api/goals", (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const opts: { title: string; description?: string; checkCron?: string } = {
      title: parsed.data.title,
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      ...(parsed.data.checkCron !== undefined ? { checkCron: parsed.data.checkCron } : {}),
    };
    const goal = deps.goals.create(opts);
    res.status(201).json({ goal });
  });

  app.patch("/api/goals/:id", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const updates: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v !== undefined) updates[k] = v;
    }
    const ok = deps.goals.update(id, updates as never);
    if (!ok) return res.status(404).json({ error: "goal not found" });
    res.json({ goal: deps.goals.get(id) });
  });

  app.delete("/api/goals/:id", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const ok = deps.goals.delete(id);
    if (!ok) return res.status(404).json({ error: "goal not found" });
    res.status(204).end();
  });
}
