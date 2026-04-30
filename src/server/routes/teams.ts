/**
 * /api/teams — team + worker CRUD.
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";

import { ValidationError } from "../../util/errors.js";
import type { ServerDeps } from "../index.js";

const workerSchema = z.object({
  name: z.string().min(1).max(64),
  profile: z.string().max(64).optional(),
  crew: z.string().max(64).optional(),
  task: z.string().min(1).max(4000),
  blockedByWorkers: z.array(z.string()).default([]),
});

const createSchema = z.object({
  name: z.string().min(1).max(120),
  task: z.string().min(1).max(4000),
  project: z.string().max(120).optional(),
  workers: z.array(workerSchema).min(1).max(32),
});

export function mountTeamRoutes(app: Express, deps: ServerDeps): void {
  app.get("/api/teams", (_req, res) => {
    const teams = deps.teamStore.listTeams().map((t) => ({
      ...t,
      workers: deps.teamStore.getWorkers(t.id),
    }));
    res.json({ teams });
  });

  app.get("/api/teams/:id", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const team = deps.teamStore.getTeam(id);
    if (!team) return res.status(404).json({ error: "team not found" });
    res.json({ team, workers: deps.teamStore.getWorkers(id) });
  });

  app.post("/api/teams", (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const opts = {
      name: parsed.data.name,
      task: parsed.data.task,
      workers: parsed.data.workers.map((w) => ({
        name: w.name,
        task: w.task,
        blockedByWorkers: w.blockedByWorkers,
        ...(w.profile ? { profile: w.profile } : {}),
        ...(w.crew ? { crew: w.crew } : {}),
      })),
      ...(parsed.data.project ? { project: parsed.data.project } : {}),
    };
    const team = deps.teamStore.createTeam(opts);
    res.status(201).json({ team, workers: deps.teamStore.getWorkers(team.id) });
  });

  app.delete("/api/teams/:id", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    if (!deps.teamStore.getTeam(id)) return res.status(404).json({ error: "team not found" });
    deps.teamStore.deleteTeam(id);
    res.status(204).end();
  });
}
