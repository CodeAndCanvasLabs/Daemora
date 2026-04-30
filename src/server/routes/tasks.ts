/**
 * /api/tasks — task history (read-only), with tool-call detail.
 *
 * Tasks are created by `TaskRunner.run()` (not by this route). Read
 * endpoints are used by the Logs / TaskDetail UI pages + cancel.
 */

import type { Express, Request, Response } from "express";

import type { ServerDeps } from "../index.js";

export function mountTaskRoutes(app: Express, deps: ServerDeps): void {
  app.get("/api/tasks", (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query["limit"] ?? 100), 500);
    res.json({ tasks: deps.tasks.list(limit) });
  });

  app.get("/api/tasks/:id", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const task = deps.tasks.get(id);
    if (!task) return res.status(404).json({ error: "task not found" });
    const toolCalls = deps.tasks.getToolCalls(id);
    res.json({ task, toolCalls });
  });

  app.delete("/api/tasks/:id", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const ok = deps.tasks.delete(id);
    if (!ok) return res.status(404).json({ error: "task not found" });
    res.status(204).end();
  });

  app.post("/api/tasks/:id/cancel", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const cancelled = deps.runner.cancel(id, "cancelled via api");
    if (!cancelled) return res.status(404).json({ error: "task not running" });
    res.json({ ok: true });
  });

  app.get("/api/tasks/:id/inflight", (_req, res) => {
    res.json({ taskIds: deps.runner.inflightTaskIds() });
  });
}
