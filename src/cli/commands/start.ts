/**
 * `daemora-ts start` — bring up config, skill registry, model router,
 * crew registry, agent loop, HTTP server. Prints the access URL
 * prominently and (in TTY mode, when setup isn't done) auto-opens the
 * setup wizard.
 */

import { exec } from "node:child_process";
import type { Server } from "node:http";

import type { Express } from "express";

import { ChannelManager } from "../../channels/ChannelManager.js";
import { ChannelRegistry } from "../../channels/ChannelRegistry.js";
import { ConfigManager } from "../../config/ConfigManager.js";
import { AgentLoop } from "../../core/AgentLoop.js";
import { CompactionManager } from "../../core/Compaction.js";
import { InboundDebouncer } from "../../core/InboundDebouncer.js";
import { LoopDetector } from "../../core/LoopDetector.js";
import { TaskRunner } from "../../core/TaskRunner.js";
import { AttachmentProcessor } from "../../core/AttachmentProcessor.js";
import { BackgroundReviewer } from "../../learning/BackgroundReviewer.js";
import { EventBus } from "../../events/eventBus.js";
import { CostTracker } from "../../costs/CostTracker.js";
import { CrewAgentRunner } from "../../crew/CrewAgentRunner.js";
import { CrewLoader } from "../../crew/CrewLoader.js";
import { CrewRegistry } from "../../crew/CrewRegistry.js";
import { IntegrationCrewSync } from "../../integrations/IntegrationCrewSync.js";
import { IntegrationManager } from "../../integrations/IntegrationManager.js";
import { IntegrationStore } from "../../integrations/IntegrationStore.js";
import { registerIntegrationTools } from "../../integrations/tools.js";
import { makeCronTool } from "../../tools/core/cronTool.js";
import { makeReplyToUserTool } from "../../tools/core/replyToUser.js";
import { makeGoalTool } from "../../tools/core/goalTool.js";
import { makeWatcherTool } from "../../tools/core/watcherTool.js";
import { makePollTool } from "../../tools/core/pollTool.js";
import { makeManageMCPTool } from "../../tools/core/manageMCP.js";
import { makeManageAgentsTool } from "../../tools/core/manageAgents.js";
import { makeReloadTool } from "../../tools/core/reloadTool.js";
import type { ToolDef } from "../../tools/types.js";
import { CronScheduler } from "../../cron/CronScheduler.js";
import { CronStore } from "../../cron/CronStore.js";
import { makeCronExecutor } from "../../scheduler/CronExecutor.js";
import { GoalPulse } from "../../scheduler/GoalPulse.js";
import { Heartbeat } from "../../scheduler/Heartbeat.js";
import { ensureMorningPulse } from "../../scheduler/MorningPulse.js";
import { DailyLog } from "../../scheduler/DailyLog.js";
import { DeliveryPresetStore } from "../../scheduler/DeliveryPresetStore.js";
import { HookRunner } from "../../hooks/HookRunner.js";
import { buildAuth, deriveSubKey } from "../../auth/index.js";
import { WebhookTokenStore } from "../../webhooks/WebhookTokenStore.js";
import { TunnelManager } from "../../tunnels/TunnelManager.js";
import { Cleanup } from "../../services/Cleanup.js";
import { Embeddings } from "../../embeddings/Embeddings.js";
import { DeclarativeMemoryStore } from "../../memory/DeclarativeMemoryStore.js";
import { MemoryStore } from "../../memory/MemoryStore.js";
import { SessionStore } from "../../memory/SessionStore.js";
import { ModelRouter } from "../../models/ModelRouter.js";
import { GoalStore } from "../../goals/GoalStore.js";
import { LiveKitServer } from "../../voice/LiveKitServer.js";
import { ExtractionPipeline } from "../../learning/ExtractionPipeline.js";
import { MemoryDecay } from "../../learning/MemoryDecay.js";
import { SmartRecall } from "../../learning/SmartRecall.js";
import { MCPIntegrationBridge } from "../../mcp/MCPIntegrationBridge.js";
import { MCPManager } from "../../mcp/MCPManager.js";
import { MCPStore } from "../../mcp/MCPStore.js";
import { AuditLog } from "../../safety/AuditLog.js";
import { FilesystemGuard, type FsGuardMode } from "../../safety/FilesystemGuard.js";
import { TaskStore } from "../../tasks/TaskStore.js";
import { TeamStore } from "../../teams/TeamStore.js";
import { WatcherStore } from "../../watchers/WatcherStore.js";
import { WatcherRunner } from "../../watchers/WatcherRunner.js";
import { SkillLoader } from "../../skills/SkillLoader.js";
import { SkillRegistry } from "../../skills/SkillRegistry.js";
import { createApp } from "../../server/index.js";
// Voice now runs via LiveKit agent worker (see src/voice/VoiceAgent.ts
// spawned from /api/voice/sidecar/start), not a custom WebSocket.
import { createLogger } from "../../util/logger.js";

const log = createLogger("cli.start");

export async function startCommand(): Promise<void> {
  // Print the Daemora banner before any logs fly. Skipped on non-TTY
  // (CI, journalctl) so log files stay clean.
  if (process.stdout.isTTY) {
    const { printBanner } = await import("../banner.js");
    const { readFileSync } = await import("node:fs");
    let version = "";
    try {
      const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf-8")) as { version: string };
      version = pkg.version;
    } catch { /* ignore */ }
    printBanner({ tagline: "the agent that lives on your machine", version });
  }

  const cfg = ConfigManager.open();
  log.info({ dataDir: cfg.env.dataDir, port: cfg.env.port }, "config opened");

  const skillsDir = process.env["SKILLS_DIR"] ?? new URL("../../../skills", import.meta.url).pathname;
  const skillSnapshotPath = `${cfg.env.dataDir}/.skills-snapshot.json`;
  // User-created skills live outside the bundled skills tree so they
  // aren't wiped on `npm install -g daemora` upgrade.
  const customSkillsDir = `${cfg.env.dataDir}/custom-skills`;
  const skillLoader = new SkillLoader(skillsDir, skillSnapshotPath, [customSkillsDir]);
  const { loaded: loadedSkills, skipped: skippedSkills } = await skillLoader.loadAll();
  if (skippedSkills.length > 0) {
    for (const s of skippedSkills) log.warn({ dir: s.dir, reason: s.reason }, "skill skipped");
  }
  const skills = new SkillRegistry(loadedSkills);
  log.info({ skills: skills.size }, "skills loaded");

  // Embeddings — semantic skill matching + memory recall, opt-in per
  // provider availability. If no API key is in the vault and Ollama
  // isn't running, `generate()` returns null and callers fall back to
  // their non-embedding path (keyword matching). TF-IDF is NOT a silent
  // default — it's opt-in via EMBEDDING_PROVIDER=tfidf because it's
  // keyword-weighted, not really semantic.
  const embeddings = new Embeddings(cfg);
  embeddings.tfidf.fit(loadedSkills.map((s) => `${s.meta.description ?? ""} ${s.meta.triggers?.join(" ") ?? ""}`));
  void embeddings.ensureOllamaModel().catch((e) => log.warn({ err: (e as Error).message }, "ollama embed bootstrap failed"));
  void embeddings.provider().then((p) => {
    if (p === null) log.info("embeddings: no provider available — semantic matching disabled (add an API key or run Ollama to enable)");
    else log.info({ provider: p }, "embeddings ready");
  });

  const models = new ModelRouter(cfg);
  const sessions = new SessionStore(cfg.database);
  const memory = new MemoryStore(cfg.database);
  const declarativeMemory = new DeclarativeMemoryStore(
    process.env["MEMORY_DIR"] ?? `${cfg.env.dataDir}/memory`,
  );
  await declarativeMemory.load();
  const costs = new CostTracker(cfg.database);
  const audit = new AuditLog(cfg.database);
  const cronStore = new CronStore(cfg.database);
  // Callback is installed after TaskRunner exists (see below); start()
  // is deferred until we can wire the executor.
  let cronScheduler: CronScheduler;
  const watchers = new WatcherStore(cfg.database);
  const goals = new GoalStore(cfg.database);
  const taskStore = new TaskStore(cfg.database);
  const teamStore = new TeamStore(cfg.database);
  const smartRecall = new SmartRecall(cfg.database, memory);
  const extraction = new ExtractionPipeline(memory);
  const decay = new MemoryDecay(cfg.database, memory);
  void smartRecall; // available for AgentLoop to use in future
  void extraction;  // wired into task completion in future
  void decay;       // run via cron job in future
  const mcpStore = new MCPStore(cfg.env.dataDir);
  const mcpManager = new MCPManager(mcpStore, cfg.vault);
  // Sync the playwright MCP entry's --user-data-dir against the
  // DAEMORA_BROWSER_PROFILE setting before connect. The setting is the
  // canonical source of truth for the active browser profile; mcp.json
  // is just a cache that gets rewritten when the user changes profiles.
  const { getActiveProfile, syncPlaywrightArgs } = await import("../../mcp/playwrightProfile.js");
  syncPlaywrightArgs(mcpStore, cfg.env.dataDir, getActiveProfile(cfg));
  // MCPManager.loadAll() is deferred until after IntegrationManager
  // exists so MCPIntegrationBridge can inject OAuth tokens into remote
  // MCP servers (GitHub, Notion, …) on the initial connect.
  const channels = new ChannelRegistry(cfg.database, (key) => {
    if (!cfg.vault.isUnlocked()) return false;
    return cfg.vault.has(key) || cfg.settings.hasGeneric(key);
  });
  log.info({
    channelsDefined: channels.defs().length,
  }, "stores ready (session, memory, costs, audit, cron, watchers, goals, tasks, channels — mcp connects after integrations)");

  // FilesystemGuard config: settings store wins, env var is the fallback,
  // "moderate" is the final default. Settings are written by the UI (PUT
  // /api/security/fs) so changes survive restarts.
  const fsModeFromSettings = cfg.settings.getGeneric("DAEMORA_FS_GUARD");
  const fsAllowFromSettings = cfg.settings.getGeneric("DAEMORA_FS_ALLOW");
  const fsDenyFromSettings = cfg.settings.getGeneric("DAEMORA_FS_DENY");
  const fsGuardMode = ((fsModeFromSettings ?? process.env["DAEMORA_FS_GUARD"]) as FsGuardMode) || "moderate";
  const fsAllow = parseFsList(fsAllowFromSettings, process.env["DAEMORA_FS_ALLOW"]);
  const fsDeny = parseFsList(fsDenyFromSettings, process.env["DAEMORA_FS_DENY"]);
  const guard = new FilesystemGuard({
    mode: fsGuardMode,
    dataDir: cfg.env.dataDir,
    extraAllow: fsAllow,
    extraDeny: fsDeny,
  });
  log.info({ mode: fsGuardMode, allow: fsAllow, deny: fsDeny, dataDir: cfg.env.dataDir }, "filesystem guard armed");

  // Phase 1: build the AgentLoop with its core tool set. Crew tools are
  // installed in phase 2, once we have an AgentLoop reference for the
  // CrewAgentRunner to share the ToolRegistry.
  // Start local LiveKit server for voice (auto-detects if already running)
  const livekitServer = new LiveKitServer();
  await livekitServer.ensureRunning().catch((e) => {
    log.warn({ err: (e as Error).message }, "livekit-server not available — voice disabled");
  });

  const hookRunner = new HookRunner(cfg.env.dataDir);
  hookRunner.load();
  hookRunner.watch();
  const hookStats = hookRunner.stats();
  const totalHooks = Object.values(hookStats).reduce((n, v) => n + v, 0);
  if (totalHooks > 0) log.info(hookStats, "user hooks active");

  const bus = new EventBus();
  const loopDetector = new LoopDetector(bus);
  // IntegrationManager owns OAuth flows for Twitter / YouTube /
  // Facebook / Instagram. It's constructed pre-AgentLoop so AgentLoop
  // can query `getEnabled()` every turn — integration-sourced tools
  // are filtered IN only when the user has connected the service.
  const integrationStore = new IntegrationStore(cfg.database, cfg);
  const integrations = new IntegrationManager(cfg, integrationStore);
  // Bridge OAuth tokens from IntegrationManager → MCPManager so remote
  // MCP servers (GitHub, Notion) authenticate against the user's
  // connected accounts without persisting tokens to disk. Must exist
  // before mcpManager.loadAll() so the token-provider is installed
  // before discovery runs.
  new MCPIntegrationBridge(integrations, mcpManager, mcpStore);
  await mcpManager.loadAll();
  log.info({
    mcpServers: mcpManager.listStatus().length,
    mcpTools: mcpManager.allTools().length,
  }, "MCP servers connected");
  const agent = new AgentLoop({
    cfg, models, skills, guard, memory,
    mcp: mcpManager, hooks: hookRunner,
    skillLoader, skillsRoot: skillsDir,
    declarativeMemory, sessions,
    bus, loopDetector,
    getEnabledIntegrations: () => integrations.getEnabled(),
  });

  // Register integration tools BEFORE the crew loader runs so crew
  // manifests that reference twitter_post / youtube_search / etc can
  // resolve them cleanly. Tools are marked `source.kind=integration`
  // and gated by ToolRegistry.available(enabledIntegrations).
  registerIntegrationTools(integrations, agent.tools);

  // Phase 2: scan the crew/ directory, resolve tool names against the
  // live registry, and hand the runner a reference to the same registry.
  const crewDir = process.env["CREW_DIR"] ?? new URL("../../../crew", import.meta.url).pathname;
  const crewLoader = new CrewLoader(crewDir);
  const { loaded: loadedCrews, skipped: skippedCrews } = await crewLoader.loadAll(agent.tools);
  for (const s of skippedCrews) log.warn({ dir: s.dir, reason: s.reason }, "crew skipped");

  // Apply persisted disabled-set: crews the user has switched off in the
  // UI shouldn't be re-registered (and re-injected into the main agent's
  // system prompt) on the next restart. Disabled ids are kept in
  // DAEMORA_DISABLED_CREWS as a JSON array.
  const disabledCrewsRaw = cfg.settings.getGeneric("DAEMORA_DISABLED_CREWS");
  const disabledCrews = new Set(
    Array.isArray(disabledCrewsRaw)
      ? disabledCrewsRaw.filter((x): x is string => typeof x === "string")
      : [],
  );
  const enabledCrews = loadedCrews.filter((c) => !disabledCrews.has(c.manifest.id));
  if (disabledCrews.size > 0) {
    log.info({ disabled: Array.from(disabledCrews) }, "skipping disabled crews");
  }
  const crews = new CrewRegistry(enabledCrews);
  const crewRunner = new CrewAgentRunner(crews, agent.tools, models, sessions, skills);
  agent.installCrews(crews, crewRunner);
  // Wire integration crews: filesystem-loaded manifests live in
  // crew/twitter|youtube|facebook|instagram/plugin.json. This sync
  // stages them out of the active CrewRegistry until the user
  // connects the matching service, then restores them on connect.
  new IntegrationCrewSync(integrations, crews, agent);
  crews.on("change", () => agent.invalidateSystemPromptCache());
  log.info(
    { crews: crews.size, names: crews.list().map((c) => c.manifest.id), toolCount: agent.tools.list().length },
    "crew system online",
  );

  // Voice uses our custom WebSocket pipeline (VoiceSocket) — no LiveKit worker needed.
  // VoiceSocket is attached to the HTTP server after listen() below.

  const compaction = new CompactionManager(sessions, models, bus);
  const reviewer = new BackgroundReviewer({ agent, sessions, bus });
  const attachmentProcessor = new AttachmentProcessor({ cfg, dataDir: cfg.env.dataDir });
  const runner = new TaskRunner(
    agent, sessions, taskStore, bus, hookRunner, compaction, reviewer, cfg.env.dataDir,
    loopDetector, attachmentProcessor, cfg, costs,
  );
  const debouncer = new InboundDebouncer({
    windowMs: Number(process.env["DEBOUNCE_MS"] ?? 1500),
  });
  const channelManager = new ChannelManager(channels, cfg, runner, bus, debouncer);
  // startAll() is deferred until AFTER the env-passphrase auto-unlock
  // below, and re-fired on every vault `unlocked` event. Channel secrets
  // (TELEGRAM_BOT_TOKEN, SLACK_BOT_TOKEN, …) live in the vault — calling
  // startAll() while the vault is locked silently skips every channel.

  // Now that TaskRunner exists, wire the cron executor + scheduler pulses.
  const cronExec = makeCronExecutor({ runner });
  cronScheduler = new CronScheduler(cronStore, async (job) => {
    audit.log("cron_fire", job.name, `job ${job.id} expression=${job.expression}`);
    return cronExec(job);
  });
  cronScheduler.start();
  ensureMorningPulse(cronStore);

  // Tools whose dependencies only exist *after* TaskRunner +
  // CronScheduler boot. Register them on the agent's tool registry now
  // so the LLM actually sees `cron`, `goal`, `watcher`, `manage_mcp`,
  // `manage_agents`, `poll`, and `reload`. Without this, the agent's
  // tool list is missing scheduling primitives entirely (see /api/tools
  // before this fix — `cron` was absent, so the model fell back to
  // shelling out to unix `crontab` and 127'd).
  // Same `as unknown as ToolDef` cast pattern that buildCoreTools uses
  // — TS gets confused by zod schema variance on this generic.
  agent.tools.register(makeCronTool(cronStore, cronScheduler) as unknown as ToolDef);
  agent.tools.register(makeGoalTool(goals) as unknown as ToolDef);
  agent.tools.register(makeWatcherTool(watchers) as unknown as ToolDef);
  agent.tools.register(makeManageMCPTool(mcpStore, mcpManager) as unknown as ToolDef);
  agent.tools.register(makeManageAgentsTool({ sessions, crews }) as unknown as ToolDef);
  agent.tools.register(makePollTool(channelManager) as unknown as ToolDef);
  agent.tools.register(makeReloadTool({ mcp: mcpManager, mcpStore, scheduler: cronScheduler, channels: channelManager }) as unknown as ToolDef);

  // Swap the bare reply_to_user (registered at AgentLoop construction
  // before ChannelManager existed) for the channel-aware variant. Now
  // the agent can pass `channels: ["telegram", "discord", ...]` and
  // the message is routed via DeliveryPresetStore (preset name) or via
  // a channel id with the `<CHANNEL>_DEFAULT_CHAT_ID` setting fallback.
  const deliveryPresetStore = new DeliveryPresetStore(cfg.database);
  agent.tools.unregister("reply_to_user");
  agent.tools.register(
    makeReplyToUserTool({
      channels: channelManager,
      deliveryPresets: deliveryPresetStore,
      cfg,
    }) as unknown as ToolDef,
  );
  const dailyLog = new DailyLog({ bus, dataDir: cfg.env.dataDir });
  dailyLog.start();
  const goalPulse = new GoalPulse(goals, runner);
  goalPulse.start();
  // Heartbeat — gated by HEARTBEAT_ENABLED + HEARTBEAT_INTERVAL_MINUTES
  // settings. 0 minutes also disables. When the user toggles this off
  // from Settings the existing instance keeps ticking until next
  // restart — the daemon hot-reads the flag on each tick.
  const heartbeatIntervalMin = (cfg.setting("HEARTBEAT_INTERVAL_MINUTES") as number | undefined) ?? 240;
  const heartbeatEnabled = (cfg.setting("HEARTBEAT_ENABLED") as boolean | undefined) ?? true;
  const heartbeat = new Heartbeat(
    { runner, goals, cron: cronStore, watchers, tasks: taskStore },
    {
      rootDir: process.cwd(),
      daemonMode: cfg.env.daemonMode,
      proactiveIntervalMinutes: heartbeatIntervalMin,
      enabledFn: () => (cfg.setting("HEARTBEAT_ENABLED") as boolean | undefined) ?? true,
    },
  );
  if (heartbeatEnabled && heartbeatIntervalMin > 0) heartbeat.start();
  else log.info("heartbeat disabled by setting");
  const watcherRunner = new WatcherRunner({ store: watchers, runner, integrations });
  watcherRunner.start();

  // Daily data-retention sweep (tasks / audit / costs / stale sub-sessions).
  // Fires ~10 s after boot so a fresh install doesn't race the tables, then
  // every 24 h. 0 in CLEANUP_AFTER_DAYS disables the sweep entirely.
  const cleanup = new Cleanup(cfg.database);
  const cleanupTimer = setInterval(() => {
    try { cleanup.run(); } catch (e) { log.warn({ err: (e as Error).message }, "cleanup sweep crashed"); }
  }, 24 * 60 * 60 * 1000);
  cleanupTimer.unref();
  setTimeout(() => {
    try { cleanup.run(); } catch { /* startup sweep failures are non-fatal */ }
  }, 10_000).unref();
  log.info({ retentionDays: cleanup.retentionDays }, "cleanup scheduled (daily)");

  const auth = buildAuth({ db: cfg.database, vault: cfg.vault, dataDir: cfg.env.dataDir });
  const authEnabled = cfg.setting("AUTH_ENABLED") === true;

  // Daemon-mode auto-unlock. Setting DAEMORA_VAULT_PASSPHRASE in the
  // environment (e.g. in a launchd plist or systemd unit) unlocks the
  // vault on startup so channels and cron can read integration tokens
  // without a human ever opening the UI. Failures are non-fatal: if
  // the passphrase is wrong, the vault stays locked and the UI will
  // prompt on first load.
  const envPassphrase = process.env["DAEMORA_VAULT_PASSPHRASE"];
  if (envPassphrase && cfg.vault.exists() && !cfg.vault.isUnlocked()) {
    try {
      cfg.vault.unlock(envPassphrase);
      log.info("vault auto-unlocked from DAEMORA_VAULT_PASSPHRASE env var");
    } catch (e) {
      log.error({ err: (e as Error).message }, "DAEMORA_VAULT_PASSPHRASE did not match — vault stays locked");
    }
  }

  // Boot channels now that the vault MIGHT be unlocked (env-passphrase
  // path), and re-fire on every UI-driven unlock so users who unlock
  // from the browser don't have to manually reload channels. startAll()
  // is idempotent — `if (this.running.has(def.id)) continue;` skips
  // already-running channels, so a second firing won't double-poll
  // Telegram (which would 409 Conflict on a duplicate getUpdates).
  const fireChannelStart = (): void => {
    channelManager.startAll().catch((e) => {
      log.error({ err: (e as Error).message }, "channel startup failed");
    });
  };
  fireChannelStart();
  cfg.vault.on("unlocked", fireChannelStart);
  cfg.vault.on("locked", () => {
    channelManager.stopAll().catch((e) => {
      log.error({ err: (e as Error).message }, "channel shutdown on vault lock failed");
    });
  });

  const webhookEncKey = deriveSubKey(auth.signingKey, "webhook-hmac-enc");
  const webhookTokens = new WebhookTokenStore(cfg.database, webhookEncKey);

  // Resolve a public URL: user-configured PUBLIC_URL wins; otherwise
  // we try cloudflared / tailscale (non-blocking — server starts even
  // if the tunnel fails). Falls back to http://localhost:<port>.
  const configuredPublic = (cfg.setting("PUBLIC_URL") as string | null) ?? "";
  const tunnel = new TunnelManager();
  let publicUrl = configuredPublic.length > 0
    ? configuredPublic.replace(/\/$/, "")
    : `http://localhost:${cfg.env.port}`;

  const app = createApp({
    cfg, agent, runner, sessions, memory, declarativeMemory,
    crews, crewLoader, models,
    costs, audit, cron: cronStore, cronScheduler,
    watchers, watcherRunner, goals, tasks: taskStore, skills, mcp: mcpManager,
    mcpStore, channels, channelManager, teamStore,
    auth, authEnabled, webhookTokens, getPublicUrl: () => publicUrl, tunnel,
    deliveryPresets: deliveryPresetStore,
    integrations,
    guard,
    skillLoader,
    customSkillsDir,
  });

  // Bind the HTTP server. If the configured port is already in use,
  // fall back to an OS-assigned random port so `daemora start` never
  // hard-fails just because something else is on 8081. The actual bound
  // port is then threaded through tunnel/banner/autoOpen so the URL
  // printed to the user matches reality.
  const server = await listenWithFallback(app, cfg.env.port, log);
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : cfg.env.port;
  if (boundPort !== cfg.env.port) {
    log.warn({ requested: cfg.env.port, bound: boundPort }, "configured port in use — fell back to random port");
  }
  if (configuredPublic.length === 0) {
    publicUrl = `http://localhost:${boundPort}`;
  }

  if (!configuredPublic) {
    tunnel.start({ port: boundPort }).then((res) => {
      if (res.kind !== "none") {
        publicUrl = res.url;
        log.info({ kind: res.kind, url: res.url }, "public URL updated from tunnel");
      }
    }).catch((e) => log.warn({ err: (e as Error).message }, "tunnel start crashed"));
  }
  log.info({ authEnabled, publicUrl, port: boundPort }, "auth + webhooks ready");

  const url = `http://localhost:${boundPort}`;
  const banner = box([
    `Daemora-TS running at`,
    `  ${url}`,
    cfg.vault.exists() ? "Vault detected — unlock from the UI to start chatting." : "Open the URL above to set up your first provider.",
  ]);
  console.log("\n" + banner + "\n");

  if (process.stdout.isTTY && !cfg.env.daemonMode && process.env["DAEMORA_NO_OPEN"] !== "1") {
    autoOpen(url);
  }

  const shutdown = (signal: NodeJS.Signals) => {
    log.info({ signal }, "shutting down");
    cronScheduler.stop();
    goalPulse.stop();
    heartbeat.stop();
    watcherRunner.stop();
    tunnel.stop();
    clearInterval(cleanupTimer);
    livekitServer.stop();
    debouncer.shutdown();
    channelManager.stopAll().catch(() => {});
    mcpManager.stopAll().catch(() => {});
    server.close(() => {
      cfg.close();
      process.exit(0);
    });
    // Force exit after 3s if something hangs.
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Parse a filesystem path list from settings (could be a JSON array or a
 * comma-separated string) or env (comma-separated). Returns an empty array
 * if neither is set, dedupes, drops empties.
 */
function parseFsList(fromSettings: unknown, fromEnv: string | undefined): readonly string[] {
  let list: string[] = [];
  if (Array.isArray(fromSettings)) {
    list = fromSettings.filter((x): x is string => typeof x === "string");
  } else if (typeof fromSettings === "string" && fromSettings.length > 0) {
    list = fromSettings.split(",");
  } else if (typeof fromEnv === "string" && fromEnv.length > 0) {
    list = fromEnv.split(",");
  }
  return Array.from(new Set(list.map((s) => s.trim()).filter(Boolean)));
}

function box(lines: readonly string[]): string {
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const horiz = "─".repeat(width);
  const top = `╭${horiz}╮`;
  const bot = `╰${horiz}╯`;
  const middle = lines.map((l) => `│  ${l.padEnd(width - 4)}  │`).join("\n");
  return `${top}\n${middle}\n${bot}`;
}

/**
 * Bind the HTTP server to `port`. If that port is already in use,
 * fall back to port 0 (OS-assigned random) instead of crashing —
 * caller reads `server.address().port` to discover the actual port.
 * Any other listen error (EACCES, etc.) is propagated as-is.
 */
function listenWithFallback(app: Express, port: number, log: { warn: (o: object, m: string) => void }): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(port);
    server.once("listening", () => resolve(server));
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EADDRINUSE") {
        reject(err);
        return;
      }
      log.warn({ port, err: err.message }, "port in use — retrying on a random port");
      const fallback = app.listen(0);
      fallback.once("listening", () => resolve(fallback));
      fallback.once("error", reject);
    });
  });
}

function autoOpen(url: string): void {
  const cmd =
    process.platform === "darwin" ? `open "${url}"` :
    process.platform === "win32"  ? `start "" "${url}"` :
                                    `xdg-open "${url}"`;
  exec(cmd, () => { /* swallow — copy/paste fallback always works */ });
}
