/**
 * /api/skills — list, inspect, reload, view body.
 *
 * Skill CREATE/EDIT/DELETE for user-authored skills goes through
 * /api/skills/custom; the agent's own `skill_manage` tool uses a
 * different (security-scanned) path for agent-initiated writes.
 */

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import type { Express, Request, Response } from "express";
import { z } from "zod";

import { NotFoundError, ValidationError } from "../../util/errors.js";
import { createLogger } from "../../util/logger.js";
import type { ServerDeps } from "../index.js";

const log = createLogger("skills.routes");

const customIdSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "id must be kebab-case (lowercase, digits, _ or -)");

const customCreateBody = z.object({
  id: customIdSchema,
  body: z.string().min(1).max(200_000),
});

const customUpdateBody = z.object({
  body: z.string().min(1).max(200_000),
});

/**
 * Resolves the path of a custom skill's SKILL.md by id, asserting the
 * resolved path is inside the customSkillsDir (no escape via ../).
 */
function customSkillFile(customDir: string, id: string): string {
  const root = resolve(customDir);
  const target = resolve(join(root, id, "SKILL.md"));
  if (target !== resolve(join(root, id, "SKILL.md")) || !target.startsWith(root + sep)) {
    throw new ValidationError(`Refused to resolve outside custom skills dir: ${id}`);
  }
  return target;
}

export function mountSkillRoutes(app: Express, deps: ServerDeps): void {
  app.get("/api/skills", (_req, res) => {
    res.json({
      skills: deps.skills.list().map((s) => ({
        id: s.meta.id,
        name: s.meta.name,
        description: s.meta.description,
        triggers: s.meta.triggers,
        requires_tools: s.meta.requires_tools,
        requires_integrations: s.meta.requires_integrations,
        platforms: s.meta.platforms,
        version: s.meta.version,
        enabled: s.meta.enabled,
        dir: s.dir,
        file: s.file,
        linkedFiles: s.linkedFiles,
      })),
    });
  });

  // ── Specific paths FIRST (Express matches in declaration order) ────
  // `/api/skills/:id` below would otherwise swallow `/api/skills/custom`
  // and `/api/skills/reload` because `:id` is a wildcard segment.

  /**
   * Re-scan disk and replace the live SkillRegistry contents. Picks up
   * new files, edits, deletions, and any custom skills written via the
   * /api/skills/custom routes below.
   */
  app.post("/api/skills/reload", async (_req: Request, res: Response) => {
    const { loaded, skipped } = await deps.skillLoader.loadAll();
    deps.skills.replace(loaded);
    deps.agent.invalidateSystemPromptCache();
    log.info({ loaded: loaded.length, skipped: skipped.length }, "skills reloaded");
    res.json({ loaded: loaded.length, skipped: skipped.length });
  });

  /**
   * GET /api/skills/custom — list all user-authored skills (the ones
   * stored in <dataDir>/custom-skills/).
   */
  app.get("/api/skills/custom", async (_req: Request, res: Response) => {
    const root = resolve(deps.customSkillsDir);
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return res.json({ skills: [] });
      throw e;
    }
    const skills: { id: string; file: string; size: number; mtime: string }[] = [];
    for (const entry of entries) {
      if (entry.startsWith(".") || entry.startsWith("_")) continue;
      const file = join(root, entry, "SKILL.md");
      try {
        const s = await stat(file);
        if (!s.isFile()) continue;
        skills.push({ id: entry, file, size: s.size, mtime: s.mtime.toISOString() });
      } catch { /* missing SKILL.md → skip */ }
    }
    res.json({ skills });
  });

  /**
   * POST /api/skills/custom — create a new custom skill. Body:
   *   { id: "my-skill", body: "---\nname: ...\n---\n# ..." }
   * Writes <customDir>/<id>/SKILL.md atomically. Reloads the registry
   * so the new skill is immediately available to the agent.
   */
  app.post("/api/skills/custom", async (req: Request, res: Response) => {
    const parsed = customCreateBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const { id, body } = parsed.data;
    const file = customSkillFile(deps.customSkillsDir, id);
    try {
      await stat(file);
      throw new ValidationError(`Skill "${id}" already exists. Use PUT to update.`);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err && err.code !== "ENOENT" && !(e instanceof ValidationError)) throw e;
      if (e instanceof ValidationError) throw e;
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body, "utf-8");

    const { loaded } = await deps.skillLoader.loadAll();
    deps.skills.replace(loaded);
    deps.agent.invalidateSystemPromptCache();

    log.info({ id, file }, "custom skill created");
    res.status(201).json({ id, file });
  });

  /**
   * PUT /api/skills/custom/:id — overwrite the body of an existing
   * custom skill. Returns 404 if it doesn't exist (agent-bundled skills
   * can't be edited via this route — those are read-only on disk).
   */
  app.put("/api/skills/custom/:id", async (req: Request, res: Response) => {
    const idResult = customIdSchema.safeParse(req.params.id ?? "");
    if (!idResult.success) throw new ValidationError(idResult.error.message);
    const id = idResult.data;
    const parsed = customUpdateBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError(parsed.error.message);

    const file = customSkillFile(deps.customSkillsDir, id);
    try { await stat(file); }
    catch { throw new NotFoundError(`Custom skill "${id}" not found.`); }
    await writeFile(file, parsed.data.body, "utf-8");

    const { loaded } = await deps.skillLoader.loadAll();
    deps.skills.replace(loaded);
    deps.agent.invalidateSystemPromptCache();

    log.info({ id, file }, "custom skill updated");
    res.json({ id, file });
  });

  /**
   * DELETE /api/skills/custom/:id — remove a custom skill folder.
   * Refuses if the resolved path falls outside the custom skills dir.
   */
  app.delete("/api/skills/custom/:id", async (req: Request, res: Response) => {
    const idResult = customIdSchema.safeParse(req.params.id ?? "");
    if (!idResult.success) throw new ValidationError(idResult.error.message);
    const id = idResult.data;

    const root = resolve(deps.customSkillsDir);
    const skillDir = resolve(join(root, id));
    if (!skillDir.startsWith(root + sep)) {
      throw new ValidationError(`Refused to delete outside custom skills dir: ${id}`);
    }
    try { await stat(skillDir); }
    catch { throw new NotFoundError(`Custom skill "${id}" not found.`); }
    await rm(skillDir, { recursive: true, force: true });

    const { loaded } = await deps.skillLoader.loadAll();
    deps.skills.replace(loaded);
    deps.agent.invalidateSystemPromptCache();

    log.info({ id, skillDir }, "custom skill deleted");
    res.json({ id, deleted: true });
  });

  // ── Wildcard `:id` routes go LAST so the specific paths above win. ──

  app.get("/api/skills/:id", async (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const skill = deps.skills.get(id);
    if (!skill) return res.status(404).json({ error: "skill not found" });
    const body = await skill.loadBody();
    res.json({
      id: skill.meta.id,
      meta: skill.meta,
      dir: skill.dir,
      file: skill.file,
      linkedFiles: skill.linkedFiles,
      body,
    });
  });

  app.get("/api/skills/:id/file", async (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const path = (req.query["path"] as string | undefined) ?? "";
    if (!path) return res.status(400).json({ error: "?path= is required" });
    const r = await deps.skills.getLinkedFile(id, path);
    if (r.kind === "err") return res.status(404).json({ error: r.reason });
    res.json({ path: r.path, content: r.content });
  });
}
