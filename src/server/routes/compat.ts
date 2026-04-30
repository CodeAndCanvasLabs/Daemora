/**
 * Compat layer: real-data endpoints backed by actual subsystems,
 * shaped to match what the React UI expects.
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";

import { ValidationError } from "../../util/errors.js";
import type { ServerDeps } from "../index.js";

export function mountCompatRoutes(app: Express, deps: ServerDeps): void {
  // ── Crew (real) ───────────────────────────────────────────────
  // Lists every crew on disk, not just the registered ones — so disabled
  // crews remain visible in the UI and can be flipped back on. Re-scans
  // on each call (admin endpoint, low traffic). The `enabled` flag is
  // sourced from the live registry, NOT the disabled-set, so a crew that
  // was unregistered for any reason (e.g. integration-gated) still
  // reports as not-enabled accurately.
  app.get("/api/crew", async (_req: Request, res: Response) => {
    const { loaded } = await deps.crewLoader.loadAll(deps.agent.tools);
    const crew = loaded.map((c) => ({
      id: c.manifest.id,
      name: c.manifest.name,
      description: c.manifest.description,
      version: c.manifest.version,
      enabled: deps.crews.has(c.manifest.id),
      status: deps.crews.has(c.manifest.id) ? ("loaded" as const) : ("disabled" as const),
      error: null,
      toolNames: c.resolvedTools,
      channelIds: [] as string[],
      hookEvents: [] as string[],
      serviceIds: [] as string[],
      cliCommands: [] as string[],
      httpRouteCount: 0,
      // Surface the manifest's optional configSchema (free-form on disk)
      // so the UI can render the per-crew config form. Falls back to
      // null when the manifest doesn't define one.
      configSchema: ((): unknown => {
        const m = c.manifest as unknown as { configSchema?: unknown };
        return (m.configSchema && typeof m.configSchema === "object") ? m.configSchema : null;
      })(),
      skills: c.manifest.skills,
      temperature: c.manifest.profile.temperature,
      model: c.manifest.profile.model ?? null,
    }));
    res.json({ crew });
  });

  // ── Tools (real) ──────────────────────────────────────────────
  app.get("/api/tools", (_req: Request, res: Response) => {
    const tools = deps.agent.tools.list().map((t) => ({
      name: t.name, description: t.description, category: t.category,
      source: t.source, alwaysOn: t.alwaysOn ?? false, destructive: t.destructive ?? false,
    }));
    res.json({ tools });
  });

  // ── Memory (real) ─────────────────────────────────────────────
  app.get("/api/memory", (_req: Request, res: Response) => {
    const entries = deps.memory.listRecentEntries({ limit: 50 });
    res.json({ entries, total: entries.length });
  });

  // ── Costs (real) ──────────────────────────────────────────────
  app.get("/api/costs/today", (_req: Request, res: Response) => {
    const totalCost = deps.costs.todayCost();
    const dailyLimit = deps.cfg.setting("MAX_DAILY_COST") ?? 10;
    res.json({
      date: new Date().toISOString().slice(0, 10),
      totalCost,
      dailyLimit,
      remaining: Math.max(0, dailyLimit - totalCost),
    });
  });

  app.get("/api/costs/daily", (req: Request, res: Response) => {
    const days = Math.min(Number(req.query["days"] ?? 30), 90);
    res.json({ breakdown: deps.costs.dailyBreakdown(days) });
  });

  // ── Audit (real) ──────────────────────────────────────────────
  app.get("/api/audit", (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query["limit"] ?? 100), 500);
    const entries = deps.audit.recent(limit);
    res.json({ entries, total: entries.length });
  });

  // ── Cron (real) ───────────────────────────────────────────────
  app.get("/api/cron/status", (_req: Request, res: Response) => {
    const jobs = deps.cron.listJobs();
    res.json({ running: true, jobCount: jobs.length });
  });

  app.get("/api/cron/jobs", (_req: Request, res: Response) => {
    // Transform the flat CronJob record into the nested shape the UI expects
    // (schedule.{kind,expr,tz,...}, delivery.{mode,...}, plus the richer
    // status fields that the JS backend used to provide). Fields the TS
    // core doesn't track yet get safe defaults.
    const jobs = deps.cron.listJobs().map((j) => {
      const delivery = (j.delivery ?? null) as { mode?: string; channel?: string | null; to?: string | null } | null;
      return {
        id: j.id,
        name: j.name,
        description: null as string | null,
        enabled: j.enabled,
        schedule: {
          kind: "cron" as const,
          expr: j.expression,
          tz: j.timezone ?? null,
          everyMs: null as number | null,
          at: null as string | null,
          staggerMs: 0,
        },
        taskInput: j.task,
        model: null as string | null,
        timeoutSeconds: 0,
        delivery: {
          mode: delivery?.mode ?? "none",
          channel: delivery?.channel ?? null,
          to: delivery?.to ?? null,
        },
        maxRetries: 0,
        failureAlert: null,
        nextRunAt: j.nextRunAt ? new Date(j.nextRunAt).toISOString() : null,
        lastRunAt: j.lastRunAt ? new Date(j.lastRunAt).toISOString() : null,
        lastStatus: null as string | null,
        lastError: null as string | null,
        lastDurationMs: null as number | null,
        consecutiveErrors: 0,
        runCount: 0,
        runningSince: null as string | null,
        tenantId: null as string | null,
        createdAt: new Date(j.createdAt).toISOString(),
      };
    });
    res.json({ jobs });
  });

  app.post("/api/cron/jobs", (req: Request, res: Response) => {
    const body = z.object({
      name: z.string().min(1),
      expression: z.string().min(1),
      task: z.string().min(1),
      timezone: z.string().default("UTC"),
    }).safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.message);
    const job = deps.cron.addJob(body.data);
    res.json({ job });
  });

  app.get("/api/cron/jobs/:id", (req: Request, res: Response) => {
    const job = deps.cron.getJob(req.params.id ?? "");
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({ job });
  });

  app.delete("/api/cron/jobs/:id", (req: Request, res: Response) => {
    const ok = deps.cron.deleteJob(req.params.id ?? "");
    res.json({ deleted: ok });
  });

  app.get("/api/cron/jobs/:id/runs", (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
    const runs = deps.cron.getJobRuns(req.params.id ?? "", limit);
    res.json({ runs });
  });

  /**
   * Fire a cron job immediately, out-of-band with the normal schedule.
   * Delegates to CronScheduler.forceRun which tracks in-flight jobs so
   * this can't double-fire with a tick that would've picked up the same
   * job. Returns once the run has started (fire-and-forget). Errors
   * (job missing / already running) come back as 4xx.
   */
  app.post("/api/cron/jobs/:id/run", async (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    try {
      // Kick off the run without awaiting completion — a cron task can
      // take minutes. The scheduler writes a "running" row immediately
      // so the UI can poll /runs to watch progress.
      void deps.cronScheduler.forceRun(id).catch(() => { /* logged in scheduler */ });
      res.json({ ok: true, jobId: id });
    } catch (e) {
      const msg = (e as Error).message;
      if (/not found/i.test(msg)) return res.status(404).json({ error: msg });
      if (/already running/i.test(msg)) return res.status(409).json({ error: msg });
      throw e;
    }
  });

  app.get("/api/cron/runs", (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
    // All runs across all jobs — get from all jobs
    const jobs = deps.cron.listJobs();
    const allRuns = jobs.flatMap((j) => deps.cron.getJobRuns(j.id, limit));
    allRuns.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    res.json({ runs: allRuns.slice(0, limit) });
  });

  // Cron presets are stored in the same SQLite-backed DeliveryPresetStore
  // as `/api/delivery-presets` — these endpoints are an alias the UI uses
  // when configuring a cron job's delivery destination(s).
  app.get("/api/cron/presets", (_req: Request, res: Response) => {
    res.json({ presets: deps.deliveryPresets.list() });
  });

  app.post("/api/cron/presets", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      id?: string;
      name?: string;
      description?: string | null;
      targets?: Array<{ channel?: string; channelMeta?: Record<string, unknown> | null; label?: string }>;
    };
    if (!body.name) return res.status(400).json({ error: "`name` is required" });
    const targets = Array.isArray(body.targets)
      ? body.targets
          .filter((t) => typeof t.channel === "string")
          .map((t) => ({
            channel: t.channel!,
            channelMeta: t.channelMeta ?? null,
            ...(t.label ? { label: t.label } : {}),
          }))
      : [];
    const preset = deps.deliveryPresets.save({
      ...(body.id ? { id: body.id } : {}),
      name: body.name,
      description: body.description ?? null,
      targets,
    });
    res.status(201).json({ preset });
  });

  app.put("/api/cron/presets/:id", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const existing = deps.deliveryPresets.get(id);
    if (!existing) return res.status(404).json({ error: "Preset not found" });
    const body = (req.body ?? {}) as {
      name?: string;
      description?: string | null;
      targets?: Array<{ channel?: string; channelMeta?: Record<string, unknown> | null; label?: string }>;
    };
    const targets = Array.isArray(body.targets)
      ? body.targets
          .filter((t) => typeof t.channel === "string")
          .map((t) => ({
            channel: t.channel!,
            channelMeta: t.channelMeta ?? null,
            ...(t.label ? { label: t.label } : {}),
          }))
      : existing.targets;
    const preset = deps.deliveryPresets.save({
      id,
      name: body.name ?? existing.name,
      description: body.description ?? existing.description,
      targets,
    });
    res.json({ preset });
  });

  app.delete("/api/cron/presets/:id", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const ok = deps.deliveryPresets.delete(id);
    if (!ok) return res.status(404).json({ error: "Preset not found" });
    res.json({ deleted: true, id });
  });

  // ── Setup status ──────────────────────────────────────────────
  app.get("/api/setup/status", (_req: Request, res: Response) => {
    const vaultExists = deps.cfg.vault.exists();
    const vaultUnlocked = deps.cfg.vault.isUnlocked();
    let hasProvider = false;
    if (vaultUnlocked) {
      hasProvider = deps.cfg.vault.has("ANTHROPIC_API_KEY")
        || deps.cfg.vault.has("OPENAI_API_KEY")
        || deps.cfg.vault.has("GOOGLE_AI_API_KEY")
        || deps.cfg.vault.has("GROQ_API_KEY");
    }
    const setupDone = deps.cfg.settings.hasGeneric("SETUP_COMPLETED");
    res.json({
      vaultExists, vaultUnlocked, hasProvider,
      hasModel: !!deps.cfg.setting("DEFAULT_MODEL"),
      completed: setupDone || (vaultExists && hasProvider),
    });
  });

  // ── Tasks / Logs (real) ────────────────────────────────────────
  app.get("/api/tasks", (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query["limit"] ?? 100), 500);
    const tasks = deps.tasks.list(limit);
    res.json({ tasks, total: tasks.length });
  });

  app.get("/api/tasks/:id", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const task = deps.tasks.get(id);
    if (!task) return res.json({ id, status: "unknown", messages: [] });
    // UI expects toolCalls as an array, not a number
    const toolCallDetails = deps.tasks.getToolCalls(id);
    res.json({
      ...task,
      toolCalls: toolCallDetails,
      toolCallCount: task.toolCalls,
    });
  });

  app.delete("/api/tasks/:id", (req: Request, res: Response) => {
    const ok = deps.tasks.delete(req.params.id ?? "");
    res.json({ ok });
  });

  // ── Skills (real) ──────────────────────────────────────────────
  app.get("/api/skills", (_req: Request, res: Response) => {
    const skills = deps.skills.list().map((s) => ({
      name: s.meta.name,
      id: s.meta.id,
      description: s.meta.description,
      triggers: s.meta.triggers,
      version: s.meta.version,
      enabled: s.meta.enabled,
    }));
    res.json({ skills, total: skills.length });
  });

  // ── Profile ───────────────────────────────────────────────────
  app.get("/api/profile", (_req: Request, res: Response) => {
    const sub = deps.cfg.settings.getGeneric("SUB_AGENT_MODEL");
    res.json({
      id: "default", name: "Default", systemPrompt: "", temperature: 0.7,
      model: deps.cfg.setting("DEFAULT_MODEL"),
      subAgentModel: typeof sub === "string" ? sub : "",
    });
  });

  app.put("/api/profile", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { subAgentModel?: unknown };
    if (typeof body.subAgentModel === "string") {
      deps.cfg.settings.setGeneric("SUB_AGENT_MODEL", body.subAgentModel);
    }
    const sub = deps.cfg.settings.getGeneric("SUB_AGENT_MODEL");
    res.json({
      id: "default", name: "Default",
      subAgentModel: typeof sub === "string" ? sub : "",
    });
  });

  // ── Watchers (real) ────────────────────────────────────────────
  app.get("/api/watchers", (_req: Request, res: Response) => {
    res.json({ watchers: deps.watchers.list() });
  });

  app.get("/api/watchers/templates", (_req: Request, res: Response) => {
    res.json({ templates: [
      { id: "github-pr", name: "GitHub PR", triggerType: "webhook", description: "Watch for new pull requests" },
      { id: "file-change", name: "File Change", triggerType: "file", description: "Watch a file or directory for changes" },
      { id: "url-check", name: "URL Health", triggerType: "poll", description: "Poll a URL and alert on status change" },
    ]});
  });

  app.post("/api/watchers", (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const name = String(body.name ?? "Untitled");
    const triggerType = (body.triggerType as string) ?? "webhook";
    const pattern = typeof body.pattern === "string" ? body.pattern : JSON.stringify(body.pattern ?? "");
    const action = String(body.action ?? "");
    const channel = body.channel ? String(body.channel) : undefined;
    const watcher = deps.watchers.create({
      name,
      ...(triggerType === "webhook" || triggerType === "poll" || triggerType === "file" || triggerType === "cron"
        ? { triggerType: triggerType as "webhook" | "poll" | "file" | "cron" }
        : {}),
      ...(pattern ? { pattern } : {}),
      ...(action ? { action } : {}),
      ...(channel ? { channel } : {}),
    });
    res.json({ watcher });
  });

  app.get("/api/watchers/:id", (req: Request, res: Response) => {
    const w = deps.watchers.get(req.params.id ?? "");
    if (!w) return res.status(404).json({ error: "Watcher not found" });
    res.json({ watcher: w });
  });

  app.put("/api/watchers/:id", (req: Request, res: Response) => {
    const ok = deps.watchers.update(req.params.id ?? "", req.body);
    if (!ok) return res.status(404).json({ error: "Watcher not found" });
    res.json({ ok: true });
  });

  app.delete("/api/watchers/:id", (req: Request, res: Response) => {
    const ok = deps.watchers.delete(req.params.id ?? "");
    res.json({ deleted: ok });
  });

  // ── Goals (real) ──────────────────────────────────────────────
  app.get("/api/goals", (_req: Request, res: Response) => {
    res.json({ goals: deps.goals.list() });
  });

  app.post("/api/goals", (req: Request, res: Response) => {
    const body = z.object({
      title: z.string().min(1),
      description: z.string().optional(),
      checkCron: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.message);
    const { description, checkCron, ...goalRest } = body.data;
    const goal = deps.goals.create({
      ...goalRest,
      ...(description ? { description } : {}),
      ...(checkCron ? { checkCron } : {}),
    });
    res.json({ goal });
  });

  app.get("/api/goals/:id", (req: Request, res: Response) => {
    const g = deps.goals.get(req.params.id ?? "");
    if (!g) return res.status(404).json({ error: "Goal not found" });
    res.json({ goal: g });
  });

  app.put("/api/goals/:id", (req: Request, res: Response) => {
    const ok = deps.goals.update(req.params.id ?? "", req.body);
    if (!ok) return res.status(404).json({ error: "Goal not found" });
    res.json({ ok: true });
  });

  app.delete("/api/goals/:id", (req: Request, res: Response) => {
    const ok = deps.goals.delete(req.params.id ?? "");
    res.json({ deleted: ok });
  });

  app.post("/api/goals/:id/check", (req: Request, res: Response) => {
    const ok = deps.goals.update(req.params.id ?? "", {}, true);
    if (!ok) return res.status(404).json({ error: "Goal not found" });
    res.json({ ok: true, checked: true });
  });

  // ── MCP (real) ─────────────────────────────────────────────────
  app.get("/api/mcp", (_req: Request, res: Response) => {
    const servers = deps.mcp.listStatus();
    res.json({ servers });
  });

  app.post("/api/mcp", (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const name = String(body.name ?? "");
    if (!name) return res.status(400).json({ error: "name required" });

    const { name: _, ...config } = body;
    try {
      deps.mcp.connect({
        name,
        ...(config.command ? { command: String(config.command) } : {}),
        ...(config.url ? { url: String(config.url) } : {}),
        ...(config.args ? { args: config.args as string[] } : {}),
        ...(config.env ? { env: config.env as Record<string, string> } : {}),
        ...(config.headers ? { headers: config.headers as Record<string, string> } : {}),
        ...(config.transport ? { transport: config.transport as "stdio" | "http" | "sse" } : {}),
      });
      res.json({ ok: true, name });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.delete("/api/mcp/:name", async (req: Request, res: Response) => {
    await deps.mcp.disconnect(req.params.name ?? "");
    res.json({ ok: true });
  });

  /**
   * GET /api/mcp/:name/config — required env keys + which are already
   * set in the vault. Never returns actual secret values.
   */
  app.get("/api/mcp/:name/config", (req: Request, res: Response) => {
    const name = req.params.name ?? "";
    const status = deps.mcp.listStatus().find((s) => s.name === name);
    if (!status) return res.status(404).json({ error: `MCP server not found: ${name}` });
    const envStatus: Record<string, { set: boolean }> = {};
    for (const k of status.requiredEnv) {
      envStatus[k] = { set: deps.cfg.vault.has(k) };
    }
    res.json({
      name,
      description: status.description ?? null,
      transport: status.transport,
      requiredEnv: status.requiredEnv,
      envStatus,
      configured: status.configured,
      enabled: status.enabled,
      connected: status.connected,
      vaultUnlocked: deps.cfg.vault.isUnlocked(),
    });
  });

  /**
   * POST /api/mcp/:name/activate
   * Body: { env?: { [envKey]: string } }
   *
   * Stores provided env values in the vault (encrypted), marks the
   * server enabled in mcp.json with `${KEY}` placeholders only, then
   * connects — secrets never land in plaintext on disk. Fails 400 if
   * required env is still missing after the merge, 423 if the vault
   * is locked and the caller tried to persist new values.
   */
  app.post("/api/mcp/:name/activate", async (req: Request, res: Response) => {
    const name = req.params.name ?? "";
    const body = (req.body as { env?: Record<string, string>; args?: Record<string, string> } | undefined) ?? {};
    const bodyEnv = body.env ?? {};
    const bodyArgs = body.args ?? {};

    const existing = deps.mcpStore.get(name);
    if (!existing) return res.status(404).json({ error: `MCP server not found: ${name}` });

    const required = deps.mcp.listStatus().find((s) => s.name === name)?.requiredEnv ?? [];

    const hasIncomingValues = Object.values(bodyEnv).some((v) => v && v !== "");
    if (hasIncomingValues && !deps.cfg.vault.isUnlocked()) {
      return res.status(423).json({
        error: "Vault is locked. Unlock before saving MCP credentials.",
      });
    }

    // Persist each non-empty env value to the vault. Empty strings
    // mean "leave the existing vault value alone" — useful when the
    // user re-opens the dialog without retyping credentials.
    for (const [key, value] of Object.entries(bodyEnv)) {
      if (value && value !== "") deps.cfg.vault.set(key, value);
    }

    const missing = required.filter((k) => {
      const inline = existing.env?.[k];
      if (inline && inline !== "" && !inline.includes("${")) return false;
      return !deps.cfg.vault.has(k);
    });
    if (missing.length > 0) {
      return res.status(400).json({
        error: `Missing required env: ${missing.join(", ")}`,
        missingEnv: missing,
      });
    }

    // Rewrite mcp.json env to `${KEY}` placeholders. Secrets stay in
    // the vault, resolved at spawn time by MCPManager.resolveEnv.
    const envPlaceholders: Record<string, string> = { ...(existing.env ?? {}) };
    for (const k of required) {
      envPlaceholders[k] = `\${${k}}`;
    }

    // Positional arg overrides — e.g. the user picked a different
    // allowed directory for the filesystem server.
    const nextArgs = [...(existing.args ?? [])];
    for (const [idxStr, value] of Object.entries(bodyArgs)) {
      const idx = Number.parseInt(idxStr, 10);
      if (!Number.isFinite(idx) || idx < 0 || !value) continue;
      while (nextArgs.length <= idx) nextArgs.push("");
      nextArgs[idx] = value;
    }

    deps.mcpStore.update(name, { env: envPlaceholders, args: nextArgs, enabled: true });
    const updated = deps.mcpStore.get(name);
    if (!updated) return res.status(500).json({ error: "Store update failed" });

    try {
      await deps.mcp.disconnect(name);
      await deps.mcp.connect(updated);
      const status = deps.mcp.listStatus().find((s) => s.name === name);
      res.json({ ok: true, status });
    } catch (e) {
      res.status(500).json({ error: `Connect failed: ${(e as Error).message}` });
    }
  });

  /**
   * POST /api/mcp/:name/deactivate — disable + disconnect. Keeps the
   * stored config around so re-activating later doesn't re-prompt.
   */
  app.post("/api/mcp/:name/deactivate", async (req: Request, res: Response) => {
    const name = req.params.name ?? "";
    const existing = deps.mcpStore.get(name);
    if (!existing) return res.status(404).json({ error: `MCP server not found: ${name}` });
    deps.mcpStore.update(name, { enabled: false });
    await deps.mcp.disconnect(name);
    res.json({ ok: true });
  });

  /**
   * POST /api/mcp/:name/:action
   * Legacy entry point — `reload` = disconnect + reconnect using the
   * current stored config. `enable` / `disable` alias to activate /
   * deactivate (but don't accept env updates; use /activate for that).
   */
  app.post("/api/mcp/:name/:action", async (req: Request, res: Response) => {
    const name = req.params.name ?? "";
    const action = req.params.action ?? "";
    const existing = deps.mcpStore.get(name);
    if (!existing) return res.status(404).json({ error: `MCP server not found: ${name}` });

    if (action === "reload") {
      try {
        await deps.mcp.disconnect(name);
        await deps.mcp.connect(existing);
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
      return;
    }
    if (action === "enable") {
      const required = deps.mcp.listStatus().find((s) => s.name === name)?.requiredEnv ?? [];
      const env = existing.env ?? {};
      const missing = required.filter((k) => !env[k] || env[k] === "");
      if (missing.length > 0) {
        return res.status(400).json({
          error: `Missing required env: ${missing.join(", ")}`,
          missingEnv: missing,
          hint: `POST /api/mcp/${name}/activate with an env object to fill them in.`,
        });
      }
      deps.mcpStore.update(name, { enabled: true });
      await deps.mcp.connect(existing);
      return res.json({ ok: true });
    }
    if (action === "disable") {
      deps.mcpStore.update(name, { enabled: false });
      await deps.mcp.disconnect(name);
      return res.json({ ok: true });
    }
    res.status(400).json({ error: `Unknown action: ${action}` });
  });

  // ── Channels (real) ───────────────────────────────────────────
  app.get("/api/channels", (_req: Request, res: Response) => {
    const statuses = deps.channels.list();
    const running = deps.channelManager.runningSet();
    const channels = statuses.map((s) => ({ ...s, running: running.has(s.id) }));
    res.json({ channels, total: channels.length });
  });

  app.get("/api/channels/defs", (_req: Request, res: Response) => {
    const defs = deps.channels.defs();
    const statuses = deps.channels.list();
    const running = deps.channelManager.runningSet();
    const channels = defs.map((d) => {
      const status = statuses.find((s) => s.id === d.id);
      return {
        name: d.id,
        label: d.name,
        desc: d.description,
        envRequired: d.requiredKeys.filter((k) => k.secret).map((k) => k.key),
        envOptional: [] as [string, string][],
        setup: [`Set ${d.requiredKeys.map((k) => k.key).join(" + ")} in your vault`],
        prompts: d.requiredKeys.map((k) => ({ key: k.key, label: k.label, secret: k.secret })),
        configured: status?.configured ?? false,
        running: running.has(d.id),
      };
    });
    res.json({ channels });
  });

  app.get("/api/channels/destinations", (_req: Request, res: Response) => {
    res.json({ destinations: deps.channels.destinations() });
  });

  app.get("/api/channels/:id/status", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const running = deps.channelManager.runningSet();
    const status = deps.channels.list().find((s) => s.id === id);
    if (!status) return res.status(404).json({ error: "Unknown channel" });
    res.json({ ...status, running: running.has(id) });
  });

  app.post("/api/channels/:id/start", async (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const ok = await deps.channelManager.start(id);
    res.json({ ok, running: deps.channelManager.runningSet().has(id) });
  });

  app.post("/api/channels/:id/stop", async (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const ok = await deps.channelManager.stop(id);
    res.json({ ok, running: deps.channelManager.runningSet().has(id) });
  });

  // ── Teams (real) ───────────────────────────────────────────────
  app.get("/api/teams", (_req: Request, res: Response) => {
    res.json({ teams: deps.teamStore.listTeams() });
  });

  app.get("/api/teams/templates", async (_req: Request, res: Response) => {
    const { teamTemplates } = await import("../../teams/templates.js");
    res.json({ templates: teamTemplates });
  });

  app.get("/api/teams/:id", (req: Request, res: Response) => {
    const team = deps.teamStore.getTeam(req.params.id ?? "");
    if (!team) return res.status(404).json({ error: "Team not found" });
    const workers = deps.teamStore.getWorkers(team.id);
    res.json({ team, workers });
  });

  app.post("/api/teams/:id/disband", (req: Request, res: Response) => {
    const ok = deps.teamStore.deleteTeam(req.params.id ?? "");
    res.json({ ok });
  });
}
