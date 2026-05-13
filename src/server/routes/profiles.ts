/**
 * /api/profiles — list available agent profiles + read/change the
 * active one.
 *
 *   GET  /api/profiles            → { active, profiles: [...] }
 *   POST /api/profiles/active     → { active }   body: { id }
 *
 * The UI's Settings page and the Setup wizard share this surface. The
 * actual `DAEMORA_PROFILE` setting is written by ProfileRegistry.setActive,
 * which also emits a `change` event AgentLoop listens to (flushes the
 * system-prompt cache so the next turn picks up the new soul.md).
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";

import { NotFoundError, ValidationError } from "../../util/errors.js";
import type { ServerDeps } from "../index.js";

const setActiveSchema = z.object({
  id: z.string().min(1).max(64),
});

export function mountProfilesRoutes(app: Express, deps: ServerDeps): void {
  app.get("/api/profiles", (_req: Request, res: Response) => {
    const profiles = deps.profiles.list().map((p) => ({
      id: p.manifest.id,
      name: p.manifest.name,
      nickname: p.manifest.nickname ?? null,
      description: p.manifest.description,
      source: p.source,
    }));
    res.json({ active: deps.profiles.getActiveId(), profiles });
  });

  app.get("/api/profiles/:id", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const p = deps.profiles.get(id);
    if (!p) return res.status(404).json({ error: "profile not found" });
    res.json({
      id: p.manifest.id,
      name: p.manifest.name,
      nickname: p.manifest.nickname ?? null,
      description: p.manifest.description,
      source: p.source,
      crews: p.crews,
      skills: p.skills,
      tools: p.tools,
    });
  });

  app.post("/api/profiles/active", async (req: Request, res: Response) => {
    const parsed = setActiveSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    if (!deps.profiles.get(parsed.data.id)) throw new NotFoundError(`Unknown profile: ${parsed.data.id}`);
    deps.profiles.setActive(parsed.data.id);
    res.json({ active: deps.profiles.getActiveId() });
  });
}
