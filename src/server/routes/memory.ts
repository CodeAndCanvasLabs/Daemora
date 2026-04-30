/**
 * /api/memory — tagged memory CRUD + declarative memory read/write.
 *
 * Two memory surfaces:
 *   /api/memory        — tagged FTS5 notebook (MemoryStore)
 *   /api/brain/*       — declarative MEMORY.md + USER.md (DeclarativeMemoryStore)
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";

import type { DeclarativeMemoryStore } from "../../memory/DeclarativeMemoryStore.js";
import { ValidationError } from "../../util/errors.js";
import type { ServerDeps } from "../index.js";

const saveSchema = z.object({
  content: z.string().min(1).max(4000),
  tags: z.array(z.string()).max(16).optional(),
  source: z.string().max(64).optional(),
});

const searchQuery = z.object({
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export interface MemoryRouteDeps extends ServerDeps {
  readonly declarativeMemory?: DeclarativeMemoryStore;
}

export function mountMemoryRoutes(app: Express, deps: MemoryRouteDeps): void {
  // ── Tagged memory (FTS5 notebook) ────────────────────────────────────
  app.get("/api/memory", (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query["limit"] ?? 50), 500);
    const offset = Math.max(Number(req.query["offset"] ?? 0), 0);
    res.json({ entries: deps.memory.listRecentEntries({ limit, offset }) });
  });

  app.get("/api/memory/search", (req: Request, res: Response) => {
    const parsed = searchQuery.safeParse(req.query);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const opts: { limit?: number } = {};
    if (parsed.data.limit !== undefined) opts.limit = parsed.data.limit;
    const hits = deps.memory.search(parsed.data.q, opts);
    res.json({ hits });
  });

  app.get("/api/memory/:id", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const entry = deps.memory.getById(id);
    if (!entry) return res.status(404).json({ error: "entry not found" });
    res.json({ entry });
  });

  app.post("/api/memory", (req: Request, res: Response) => {
    const parsed = saveSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const opts: { content: string; tags?: string[]; source?: string } = {
      content: parsed.data.content,
      ...(parsed.data.tags ? { tags: parsed.data.tags } : {}),
      ...(parsed.data.source ? { source: parsed.data.source } : {}),
    };
    const entry = deps.memory.save(opts);
    res.status(201).json({ entry });
  });

  app.delete("/api/memory/:id", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const ok = deps.memory.delete(id);
    if (!ok) return res.status(404).json({ error: "entry not found" });
    res.status(204).end();
  });

  // ── Declarative memory (MEMORY.md + USER.md) ─────────────────────────
  if (deps.declarativeMemory) {
    const decl = deps.declarativeMemory;

    app.get("/api/brain/:target", (req: Request, res: Response) => {
      const target = req.params.target;
      if (target !== "memory" && target !== "user") {
        return res.status(400).json({ error: "target must be 'memory' or 'user'" });
      }
      res.json({
        target,
        entries: decl.listEntries(target),
        systemPromptBlock: decl.formatForSystemPrompt(target),
      });
    });

    app.post("/api/brain/:target", async (req: Request, res: Response) => {
      const target = req.params.target;
      if (target !== "memory" && target !== "user") {
        return res.status(400).json({ error: "target must be 'memory' or 'user'" });
      }
      const action = (req.body?.action ?? "add") as "add" | "replace" | "remove";
      const content = req.body?.content as string | undefined;
      const oldText = req.body?.old_text as string | undefined;
      let r;
      if (action === "add") {
        if (!content) return res.status(400).json({ error: "content required" });
        r = await decl.add(target, content);
      } else if (action === "replace") {
        if (!oldText || !content) return res.status(400).json({ error: "old_text + content required" });
        r = await decl.replace(target, oldText, content);
      } else {
        if (!oldText) return res.status(400).json({ error: "old_text required" });
        r = await decl.remove(target, oldText);
      }
      res.json(r);
    });
  }
}
