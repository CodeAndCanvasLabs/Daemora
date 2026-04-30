/**
 * /api/mcp — MCP server lifecycle + tool discovery.
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";

import { ValidationError } from "../../util/errors.js";
import type { ServerDeps } from "../index.js";

const addServerSchema = z.object({
  name: z.string().min(1).max(64),
  command: z.string().min(1).max(512),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
});

export function mountMCPRoutes(app: Express, deps: ServerDeps): void {
  app.get("/api/mcp", (_req, res) => {
    res.json({
      servers: deps.mcp.listStatus(),
      tools: deps.mcp.allTools(),
    });
  });

  app.get("/api/mcp/:name", (req: Request, res: Response) => {
    const name = req.params.name ?? "";
    const status = deps.mcp.listStatus().find((s) => s.name === name);
    if (!status) return res.status(404).json({ error: "mcp server not found" });
    res.json({ server: status });
  });

  app.post("/api/mcp", async (req: Request, res: Response) => {
    const parsed = addServerSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const existing = deps.mcpStore.get(parsed.data.name);
    if (existing) {
      deps.mcpStore.update(parsed.data.name, {
        command: parsed.data.command,
        args: parsed.data.args,
        env: parsed.data.env,
        enabled: parsed.data.enabled,
      });
    } else {
      deps.mcpStore.add(parsed.data.name, {
        command: parsed.data.command,
        args: parsed.data.args,
        env: parsed.data.env,
        enabled: parsed.data.enabled,
      });
    }
    await deps.mcp.loadAll();
    res.status(201).json({ ok: true });
  });

  app.patch("/api/mcp/:name", async (req: Request, res: Response) => {
    const name = req.params.name ?? "";
    const updated = deps.mcpStore.update(name, req.body ?? {});
    if (!updated) return res.status(404).json({ error: "mcp server not found" });
    await deps.mcp.loadAll();
    res.json({ server: updated });
  });

  app.post("/api/mcp/:name/enable", async (req: Request, res: Response) => {
    const name = req.params.name ?? "";
    const updated = deps.mcpStore.update(name, { enabled: true });
    if (!updated) return res.status(404).json({ error: "mcp server not found" });
    await deps.mcp.loadAll();
    res.json({ ok: true });
  });

  app.post("/api/mcp/:name/disable", async (req: Request, res: Response) => {
    const name = req.params.name ?? "";
    const updated = deps.mcpStore.update(name, { enabled: false });
    if (!updated) return res.status(404).json({ error: "mcp server not found" });
    await deps.mcp.loadAll();
    res.json({ ok: true });
  });

  app.delete("/api/mcp/:name", async (req: Request, res: Response) => {
    const name = req.params.name ?? "";
    const ok = deps.mcpStore.remove(name);
    if (!ok) return res.status(404).json({ error: "mcp server not found" });
    await deps.mcp.loadAll();
    res.status(204).end();
  });

  app.post("/api/mcp/reload", async (_req, res) => {
    await deps.mcp.loadAll();
    res.json({ ok: true, servers: deps.mcp.listStatus().length, tools: deps.mcp.allTools().length });
  });
}
