/**
 * /api/projects — read-only listing of the agent's project workspaces
 * (the sealed-workspace spine). Backed by ProjectStore over <dataDir>/projects.
 */

import type { Express, Request, Response } from "express";

import { ProjectStore, PROJECT_KINDS, type ProjectKind } from "../../files/ProjectStore.js";
import type { ServerDeps } from "../index.js";

export function mountProjectRoutes(app: Express, deps: ServerDeps): void {
  const store = new ProjectStore(deps.cfg.env.dataDir);

  app.get("/api/projects", (_req: Request, res: Response) => {
    res.json({ projects: store.list(), kinds: PROJECT_KINDS });
  });

  /** Create a new project. */
  app.post("/api/projects", (req: Request, res: Response) => {
    const { name, kind, description } = req.body as { name?: string; kind?: ProjectKind; description?: string };
    if (!name || typeof name !== "string") return res.status(400).json({ error: "name required" });
    try { res.json({ ok: true, project: store.createProject({ name, ...(kind ? { kind } : {}), ...(description ? { description } : {}) }) }); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  /** Rename / change kind / edit description. */
  app.patch("/api/projects/:slug", (req: Request, res: Response) => {
    const { name, kind, description } = req.body as { name?: string; kind?: ProjectKind; description?: string };
    try {
      res.json({ ok: true, project: store.updateProject(req.params.slug ?? "", {
        ...(name !== undefined ? { name } : {}), ...(kind !== undefined ? { kind } : {}), ...(description !== undefined ? { description } : {}),
      }) });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  /** Delete an entire project. */
  app.delete("/api/projects/:slug", (req: Request, res: Response) => {
    try { store.deleteProject(req.params.slug ?? ""); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  app.get("/api/projects/:slug", (req: Request, res: Response) => {
    const detail = store.detail(req.params.slug ?? "");
    if (!detail) return res.status(404).json({ error: "project not found" });
    res.json(detail);
  });

  // Full recursive file tree (VS Code-style explorer) for one project.
  app.get("/api/projects/:slug/tree", (req: Request, res: Response) => {
    const tree = store.tree(req.params.slug ?? "");
    if (tree === null) return res.status(404).json({ error: "project not found" });
    res.json({ tree });
  });

  // ── file management (upload / new / move / delete) ───────────────
  // Confined to the project dir by ProjectStore.safeAbs; errors → 400.

  /** Upload one or more files (base64) into `dir` (default project root). */
  app.post("/api/projects/:slug/upload", (req: Request, res: Response) => {
    const slug = req.params.slug ?? "";
    const body = req.body as { dir?: string; files?: Array<{ name: string; base64: string }> };
    if (!Array.isArray(body.files) || body.files.length === 0) return res.status(400).json({ error: "no files" });
    const dir = (body.dir ?? "").replace(/^\/+|\/+$/g, "");
    try {
      const written = body.files.map((f) => {
        const safeName = f.name.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^\.+/, "").slice(0, 200) || "file";
        const rel = dir ? `${dir}/${safeName}` : safeName;
        return store.writeFile(slug, rel, Buffer.from(f.base64, "base64")).rel;
      });
      res.json({ ok: true, written });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  /** Create a new empty file (or folder if path ends with "/"). */
  app.post("/api/projects/:slug/file", (req: Request, res: Response) => {
    const slug = req.params.slug ?? "";
    const path = (req.body as { path?: string }).path;
    if (!path || typeof path !== "string") return res.status(400).json({ error: "path required" });
    try { res.json({ ok: true, ...store.createEntry(slug, path) }); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  /** Move/rename a file or folder within the project. */
  app.post("/api/projects/:slug/move", (req: Request, res: Response) => {
    const slug = req.params.slug ?? "";
    const { from, to } = req.body as { from?: string; to?: string };
    if (!from || !to) return res.status(400).json({ error: "from + to required" });
    try { res.json({ ok: true, ...store.move(slug, from, to) }); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  /** Delete a file or folder within the project. */
  app.delete("/api/projects/:slug/file", (req: Request, res: Response) => {
    const slug = req.params.slug ?? "";
    const path = (req.query.path as string) ?? "";
    if (!path) return res.status(400).json({ error: "path required" });
    try { store.remove(slug, path); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
}
