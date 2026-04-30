/**
 * Express bootstrap. Mounts route modules, common middleware, and
 * surfaces typed errors as proper HTTP responses.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import express from "express";
import type { Express, NextFunction, Request, Response } from "express";

import type { ChannelManager } from "../channels/ChannelManager.js";
import type { ChannelRegistry } from "../channels/ChannelRegistry.js";
import type { ConfigManager } from "../config/ConfigManager.js";
import type { AgentLoop } from "../core/AgentLoop.js";
import type { TaskRunner } from "../core/TaskRunner.js";
import type { CostTracker } from "../costs/CostTracker.js";
import type { CrewRegistry } from "../crew/CrewRegistry.js";
import type { CronStore } from "../cron/CronStore.js";
import type { CronScheduler } from "../cron/CronScheduler.js";
import type { MCPManager } from "../mcp/MCPManager.js";
import type { DeclarativeMemoryStore } from "../memory/DeclarativeMemoryStore.js";
import type { MemoryStore } from "../memory/MemoryStore.js";
import type { SessionStore } from "../memory/SessionStore.js";
import type { GoalStore } from "../goals/GoalStore.js";
import type { AuditLog } from "../safety/AuditLog.js";
import type { SkillRegistry } from "../skills/SkillRegistry.js";
import type { TaskStore } from "../tasks/TaskStore.js";
import type { TeamStore } from "../teams/TeamStore.js";
import type { WatcherStore } from "../watchers/WatcherStore.js";
import type { WatcherRunner } from "../watchers/WatcherRunner.js";
import type { Auth } from "../auth/index.js";
import type { IntegrationManager } from "../integrations/IntegrationManager.js";
import type { TunnelManager } from "../tunnels/TunnelManager.js";
import type { WebhookTokenStore } from "../webhooks/WebhookTokenStore.js";
import { DaemoraError, toDaemoraError } from "../util/errors.js";
import { createLogger } from "../util/logger.js";
import { mountAuthRoutes } from "./routes/auth.js";
import { mountChannelRoutes } from "./routes/channels.js";
import { mountChatRoutes } from "./routes/chat.js";
import { mountCompatRoutes } from "./routes/compat.js";
import { mountConfigRoutes } from "./routes/config.js";
import { mountCostRoutes } from "./routes/costs.js";
import { mountCrewRoutes } from "./routes/crew.js";
import { mountCronRoutes } from "./routes/cron.js";
import { mountGoalRoutes } from "./routes/goals.js";
import { mountMCPRoutes } from "./routes/mcp.js";
import { mountMemoryRoutes } from "./routes/memory.js";
import { mountProviderRoutes } from "./routes/providers.js";
import { mountSecurityRoutes } from "./routes/security.js";
import { mountSessionRoutes } from "./routes/sessions.js";
import { mountSkillRoutes } from "./routes/skills.js";
import { mountTaskRoutes } from "./routes/tasks.js";
import { mountTeamRoutes } from "./routes/teams.js";
import { mountVaultRoutes } from "./routes/vault.js";
import { mountVoiceRoutes } from "./routes/voice.js";
import { mountWatcherRoutes } from "./routes/watchers.js";
import { mountIntegrationRoutes } from "./routes/integrations.js";
import { mountTunnelRoutes } from "./routes/tunnel.js";
import { mountDeliveryPresetRoutes } from "./routes/deliveryPresets.js";
import type { DeliveryPresetStore } from "../scheduler/DeliveryPresetStore.js";
import { mountWebhookRoutes } from "../webhooks/WebhookHandler.js";
import { requireAuth } from "./middleware/requireAuth.js";
import { cors, createSecurityHeaders } from "./middleware/security.js";

const log = createLogger("server");

export interface ServerDeps {
  readonly cfg: ConfigManager;
  readonly agent: AgentLoop;
  readonly runner: TaskRunner;
  readonly sessions: SessionStore;
  readonly memory: MemoryStore;
  readonly declarativeMemory?: DeclarativeMemoryStore;
  readonly crews: CrewRegistry;
  readonly crewLoader: import("../crew/CrewLoader.js").CrewLoader;
  readonly models: import("../models/ModelRouter.js").ModelRouter;
  readonly costs: CostTracker;
  readonly audit: AuditLog;
  readonly cron: CronStore;
  readonly cronScheduler: CronScheduler;
  readonly watchers: WatcherStore;
  readonly watcherRunner: WatcherRunner;
  readonly goals: GoalStore;
  readonly tasks: TaskStore;
  readonly skills: SkillRegistry;
  readonly mcp: MCPManager;
  readonly mcpStore: import("../mcp/MCPStore.js").MCPStore;
  readonly channels: ChannelRegistry;
  readonly channelManager: ChannelManager;
  readonly teamStore: TeamStore;
  readonly auth: Auth;
  readonly webhookTokens: WebhookTokenStore;
  /**
   * When true, the requireAuth middleware gates all /api/* routes.
   * When false (default, for dev / first-run), the middleware is a
   * no-op. Flipped via the `AUTH_ENABLED` setting.
   */
  readonly authEnabled: boolean;
  /**
   * Externally reachable URL used for webhook registration. Accessed
   * as a getter because the tunnel provider may resolve AFTER server
   * startup — when it does, routes pick up the new value on next call.
   */
  readonly getPublicUrl: () => string;
  readonly tunnel: TunnelManager;
  readonly deliveryPresets: DeliveryPresetStore;
  readonly integrations: IntegrationManager;
  readonly guard: import("../safety/FilesystemGuard.js").FilesystemGuard;
  readonly skillLoader: import("../skills/SkillLoader.js").SkillLoader;
  readonly customSkillsDir: string;
}

export function createApp(deps: ServerDeps): Express {
  const app = express();
  // Capture the raw body alongside JSON parsing — channel webhooks
  // (LINE HMAC, etc.) need the unparsed bytes for signature checks.
  app.use(
    express.json({
      // 40 MB leaves headroom for base64-encoded file attachments
      // (UI encodes up to ~25 MB of raw bytes, which is ~33 MB base64).
      limit: "40mb",
      verify: (req: Request, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    }),
  );
  // Twilio / form-encoded webhooks (WhatsApp) send application/x-www-form-urlencoded.
  app.use(
    express.urlencoded({
      extended: true,
      verify: (req: Request, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    }),
  );

  // Channel webhook entrypoint — POST /webhooks/:id dispatches to the
  // currently-running channel of that id.
  app.post("/webhooks/:id", async (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const rawBody = (req as Request & { rawBody?: string }).rawBody ?? null;
    const ok = await deps.channelManager.dispatchWebhook(
      id,
      { headers: req.headers, body: req.body, method: req.method, query: req.query as Record<string, unknown> },
      {
        status(code: number) {
          res.status(code);
          return this;
        },
        json(body: unknown) {
          res.json(body);
          return this;
        },
        send(body: string) {
          res.send(body);
          return this;
        },
        end(body?: string) {
          res.end(body);
        },
      },
      rawBody,
    );
    if (!ok && !res.headersSent) res.status(404).json({ error: "channel not running" });
  });

  // Light request log — body never logged.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    log.debug({ method: req.method, path: req.path }, "request");
    next();
  });

  // ── Security middleware (applies everywhere, including static) ─────────
  // CSP needs to permit WebSockets to the LiveKit server at runtime —
  // the voice room lives on a different origin (e.g. ws://localhost:7880)
  // so a static 'self' policy would block it. Derive the allowed origins
  // from the current LIVEKIT_URL setting on each request so config
  // changes take effect without a server restart.
  app.use(
    createSecurityHeaders({
      extraConnectOrigins: () => {
        const liveKitUrl = deps.cfg.setting("LIVEKIT_URL") ?? process.env["LIVEKIT_URL"] ?? "";
        const origins: string[] = [];
        if (liveKitUrl) {
          try {
            const u = new URL(liveKitUrl);
            // Allow both the declared scheme and its HTTP twin — the
            // LiveKit client does fetch() probes over http/https before
            // upgrading to ws/wss, so both have to be whitelisted.
            const wsScheme = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : u.protocol;
            const httpScheme = wsScheme === "wss:" ? "https:" : wsScheme === "ws:" ? "http:" : "https:";
            const port = u.port;
            const host = u.hostname;
            // Loopback whitelist — the voice token endpoint rewrites
            // the LiveKit URL to match the browser's Host header (so a
            // browser on localhost talks to ws://localhost:PORT even if
            // the config says 127.0.0.1). To keep CSP from blocking any
            // of those variants, allow every loopback alias on the port.
            const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
            const hosts = isLoopback ? ["localhost", "127.0.0.1", "[::1]"] : [host];
            for (const h of hosts) {
              const authority = port ? `${h}:${port}` : h;
              origins.push(`${wsScheme}//${authority}`, `${httpScheme}//${authority}`);
            }
          } catch {
            // Malformed URL — leave CSP strict.
          }
        }
        return origins;
      },
    }),
  );
  const allowedOrigins = (process.env["CORS_ALLOW_ORIGINS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(cors({ allowedOrigins }));

  // Auth gate — guards /api/* + /auth/sessions + /auth/audit + /auth/session.
  // Login/refresh/logout bypass is handled inside the middleware.
  app.use(
    requireAuth({
      fileToken: deps.auth.fileToken,
      enabled: deps.authEnabled,
    }),
  );

  // Auth routes — always mounted. If authEnabled=false they still work,
  // just nothing requires them yet. Handy for pre-enabling the UI flow.
  mountAuthRoutes(app, deps.auth);

  // Serve the Daemora UI from ui/dist/ (full UI source lives at ui/).
  const uiDir = process.env["DAEMORA_UI_DIR"] ?? join(dirname(fileURLToPath(import.meta.url)), "../../ui/dist");
  app.use(express.static(uiDir));
  // SPA fallback — inject the loopback file-token as a <meta> tag so
  // same-machine UI loads can auth-fetch without a login step. Remote
  // browsers never see the token because the injector noops when the
  // request peer isn't loopback.
  app.get("*", (req, res, next) => {
    if (
      req.path.startsWith("/api/")
      || req.path === "/health"
      || req.path.startsWith("/oauth/")
      || req.path.startsWith("/webhooks/")
      || req.path.startsWith("/hooks/")
    ) return next();
    const indexPath = join(uiDir, "index.html");
    try {
      const raw = readFileSync(indexPath, "utf-8");
      const peer = req.socket.remoteAddress;
      const isLocal = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
      const injected = isLocal && deps.authEnabled
        ? raw.replace("</head>", `<meta name="api-token" content="${deps.auth.fileToken}"></head>`)
        : raw;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(injected);
    } catch {
      next();
    }
  });

  app.get(["/health", "/api/health"], (_req, res) => {
    res.json({
      ok: true,
      status: "ok",
      uptime: Math.floor(process.uptime()),
      tools: deps.agent.tools.list().length,
      model: deps.cfg.setting("DEFAULT_MODEL") ?? "ollama:llama3.1",
      permissionTier: "full",
      queue: { pending: 0, running: 0, completed: 0, failed: 0, total: 0 },
      todayCost: deps.costs.todayCost(),
      vault_unlocked: deps.cfg.vault.isUnlocked(),
      vault_exists: deps.cfg.vault.exists(),
    });
  });

  // Express dispatches by first-registered handler. compat.ts already
  // implements the full UI-facing surface (tasks, costs, cron, mcp,
  // skills, goals, memory, crew, channels, teams, watchers...) with the
  // exact shapes the React UI expects. Mount it FIRST so those paths
  // win. The new dedicated route modules below register additional
  // endpoints (PATCH, search, /file, /summary, etc.) compat doesn't have.
  mountCompatRoutes(app, deps);

  mountChannelRoutes(app, deps);
  mountChatRoutes(app, deps);
  mountConfigRoutes(app, deps);
  mountCostRoutes(app, deps);
  mountCrewRoutes(app, deps);
  mountCronRoutes(app, deps);
  mountGoalRoutes(app, deps);
  mountMCPRoutes(app, deps);
  mountMemoryRoutes(app, deps);
  mountProviderRoutes(app, deps);
  mountSecurityRoutes(app, deps);
  mountSessionRoutes(app, deps);
  mountSkillRoutes(app, deps);
  mountTaskRoutes(app, deps);
  mountTeamRoutes(app, deps);
  mountVaultRoutes(app, deps);
  mountVoiceRoutes(app, deps);  // voice token + sidecar control
  mountWatcherRoutes(app, deps);
  mountTunnelRoutes(app, deps.tunnel, deps.getPublicUrl);
  mountIntegrationRoutes(app, { integrations: deps.integrations, getPublicUrl: deps.getPublicUrl, cfg: deps.cfg });
  mountDeliveryPresetRoutes(app, deps.deliveryPresets);
  mountWebhookRoutes(app, {
    runner: deps.runner,
    watchers: deps.watchers,
    webhookTokens: deps.webhookTokens,
    authStore: deps.auth.store,
  });
  // (compat is now mounted FIRST above so its UI-shaped responses win
  //  for paths the new dedicated route modules also define.)

  // Final error handler — converts thrown errors to typed JSON responses.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err instanceof DaemoraError ? err : toDaemoraError(err);
    log.error({ code: e.code, status: e.status, message: e.message }, "request failed");
    res.status(e.status).json(e.toJSON());
  });

  return app;
}
