/**
 * /api/costs — token usage + USD cost reporting.
 */

import type { Express, Request, Response } from "express";

import type { ServerDeps } from "../index.js";

export function mountCostRoutes(app: Express, deps: ServerDeps): void {
  app.get("/api/costs/today", (_req, res) => {
    res.json({ totalCostUsd: deps.costs.todayCost() });
  });

  app.get("/api/costs/daily", (req: Request, res: Response) => {
    const days = Math.min(Math.max(Number(req.query["days"] ?? 30), 1), 365);
    res.json({ days, breakdown: deps.costs.dailyBreakdown(days) });
  });

  app.get("/api/costs/tasks/:id", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    res.json(deps.costs.taskCost(id));
  });

  app.get("/api/costs/summary", (_req, res) => {
    res.json({
      today: deps.costs.todayCost(),
      last30Days: deps.costs.dailyBreakdown(30),
    });
  });
}
