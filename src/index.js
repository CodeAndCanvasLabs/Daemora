import express from "express";
import { mkdirSync } from "fs";
import { toolFunctions } from "./tools/index.js";
import { getSession } from "./services/sessions.js";
import { config } from "./config/default.js";
import { listAvailableModels } from "./models/ModelRouter.js";
import taskQueue from "./core/TaskQueue.js";
import taskRunner from "./core/TaskRunner.js";
import { loadTask, listTasks } from "./storage/TaskStore.js";
import { getTodayCost } from "./core/CostTracker.js";
import supervisor from "./agents/Supervisor.js";
import { getActiveSubAgentCount } from "./agents/SubAgentManager.js";
import channelRegistry from "./channels/index.js";
import skillLoader from "./skills/SkillLoader.js";
import mcpManager from "./mcp/MCPManager.js";
import auditLog from "./safety/AuditLog.js";
import scheduler from "./scheduler/Scheduler.js";
import heartbeat from "./scheduler/Heartbeat.js";
import { mountAgentCard } from "./a2a/AgentCard.js";
import { mountA2AServer } from "./a2a/A2AServer.js";
import voiceWebhook from "./voice/VoiceWebhook.js";
import daemonManager from "./daemon/DaemonManager.js";
import secretVault from "./safety/SecretVault.js";
import tenantManager from "./tenants/TenantManager.js";

// Ensure all data directories exist
const dirs = [
  config.dataDir,
  config.sessionsDir,
  config.tasksDir,
  config.memoryDir,
  config.auditDir,
  config.costsDir,
  config.skillsDir,
];
for (const dir of dirs) {
  mkdirSync(dir, { recursive: true });
}

// Initialize task system
taskQueue.init();
taskRunner.start();
supervisor.start();
auditLog.start();
scheduler.start();
heartbeat.start();

const app = express();
app.use(express.json());

// Mount A2A protocol endpoints
mountAgentCard(app);
mountA2AServer(app);

// Mount voice call webhooks (Twilio callbacks during live calls)
app.use("/voice", voiceWebhook);

// --- Health check ---
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    tools: Object.keys(toolFunctions).length,
    model: config.defaultModel,
    permissionTier: config.permissionTier,
    queue: taskQueue.stats(),
    todayCost: getTodayCost(),
  });
});

// --- Chat endpoint (DISABLED - no authentication, anyone on the network could submit tasks) ---
// Uncomment and add authentication middleware before re-enabling.
// app.post("/chat", async (req, res) => { ... });

// --- Task submit endpoint (DISABLED - same reason, unauthenticated) ---
// app.post("/tasks", (req, res) => { ... });

app.get("/tasks/:id", (req, res) => {
  const task = loadTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }
  res.json(task);
});

app.get("/tasks", (req, res) => {
  const { limit, status } = req.query;
  const tasks = listTasks({
    limit: limit ? parseInt(limit, 10) : 20,
    status: status || null,
  });
  res.json({
    tasks: tasks.map((t) => ({
      id: t.id,
      status: t.status,
      channel: t.channel,
      input: t.input.slice(0, 100),
      cost: t.cost,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    })),
    queue: taskQueue.stats(),
  });
});

// --- Session endpoint ---
app.get("/sessions/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }
  res.json(session);
});

// --- Config endpoint ---
app.get("/config", (req, res) => {
  res.json({
    defaultModel: config.defaultModel,
    permissionTier: config.permissionTier,
    maxCostPerTask: config.maxCostPerTask,
    maxDailyCost: config.maxDailyCost,
    daemonMode: config.daemonMode,
    heartbeatIntervalMinutes: config.heartbeatIntervalMinutes,
    channels: Object.fromEntries(
      Object.entries(config.channels).map(([k, v]) => [k, { enabled: v.enabled }])
    ),
  });
});

// --- Models endpoint ---
app.get("/models", (req, res) => {
  res.json({
    default: config.defaultModel,
    available: listAvailableModels(),
  });
});

// --- Supervisor endpoint ---
app.get("/supervisor", (req, res) => {
  res.json({
    warnings: supervisor.getWarnings(),
    activeSubAgents: getActiveSubAgentCount(),
  });
});

// --- WhatsApp webhook ---
app.post("/webhooks/whatsapp", async (req, res) => {
  const whatsapp = channelRegistry.get("whatsapp");
  if (!whatsapp || !whatsapp.running) {
    return res.status(503).json({ error: "WhatsApp channel not active" });
  }
  try {
    await whatsapp.handleWebhook(req.body);
    res.status(200).send("OK");
  } catch (error) {
    console.error("[WhatsApp Webhook] Error:", error.message);
    res.status(500).send("Error");
  }
});

// --- Microsoft Teams webhook ---
app.post("/webhooks/teams", async (req, res) => {
  const teams = channelRegistry.get("teams");
  if (!teams || !teams.running) {
    return res.status(503).json({ error: "Teams channel not active" });
  }
  try {
    await teams.handleWebhook(req, res);
  } catch (error) {
    console.error("[Teams Webhook] Error:", error.message);
    if (!res.headersSent) res.status(500).send("Error");
  }
});

// --- Google Chat webhook ---
app.post("/webhooks/googlechat", async (req, res) => {
  const gc = channelRegistry.get("googlechat");
  if (!gc || !gc.running) {
    return res.status(503).json({ error: "Google Chat channel not active" });
  }
  try {
    await gc.handleWebhook(req, res);
  } catch (error) {
    console.error("[GoogleChat Webhook] Error:", error.message);
    if (!res.headersSent) res.status(500).send("Error");
  }
});

// --- LINE webhook (needs raw body for HMAC-SHA256 signature validation) ---
app.post("/webhooks/line", express.raw({ type: "application/json" }), async (req, res) => {
  const line = channelRegistry.get("line");
  if (!line || !line.running) {
    return res.status(503).json({ error: "LINE channel not active" });
  }
  try {
    const rawBody = req.body; // Buffer (express.raw)
    const signature = req.headers["x-line-signature"];
    const body = JSON.parse(rawBody.toString("utf8"));
    const result = await line.handleWebhook(rawBody, signature, body);
    if (result.error) {
      return res.status(401).json(result);
    }
    res.status(200).json(result);
  } catch (error) {
    console.error("[LINE Webhook] Error:", error.message);
    res.status(500).send("Error");
  }
});

// --- Channels endpoint ---
app.get("/channels", (req, res) => {
  res.json({ channels: channelRegistry.list() });
});

// --- Skills endpoint ---
app.get("/skills", (req, res) => {
  res.json({ skills: skillLoader.list() });
});

app.post("/skills/reload", (req, res) => {
  skillLoader.reload();
  res.json({ message: "Skills reloaded", skills: skillLoader.list() });
});

// --- Schedule endpoints ---
app.post("/schedules", (req, res) => {
  try {
    const { cronExpression, taskInput, channel, model, name } = req.body;
    if (!cronExpression || !taskInput) {
      return res.status(400).json({ error: "cronExpression and taskInput are required" });
    }
    const schedule = scheduler.create({ cronExpression, taskInput, channel, model, name });
    res.status(201).json(schedule);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/schedules", (req, res) => {
  res.json({ schedules: scheduler.list() });
});

app.delete("/schedules/:id", (req, res) => {
  scheduler.delete(req.params.id);
  res.json({ message: "Schedule deleted" });
});

// --- Audit endpoint ---
app.get("/audit", (req, res) => {
  res.json(auditLog.stats());
});

// --- MCP endpoints ---
app.get("/mcp", (req, res) => {
  const cfg = mcpManager.readConfig().mcpServers || {};
  const live = mcpManager.list();
  const servers = Object.entries(cfg)
    .filter(([k]) => !k.startsWith("_comment"))
    .map(([name, serverCfg]) => {
      const liveEntry = live.find(s => s.name === name);
      return {
        name,
        enabled: serverCfg.enabled !== false,
        connected: liveEntry?.connected ?? false,
        tools: liveEntry?.tools ?? [],
        type: serverCfg.command ? "stdio" : (serverCfg.transport || "http"),
        command: serverCfg.command || null,
        url: serverCfg.url || null,
      };
    });
  res.json({ servers });
});

// Add a new MCP server
app.post("/mcp", async (req, res) => {
  const { name, command, args, url, transport, env } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  if (!command && !url) return res.status(400).json({ error: "command (stdio) or url (http/sse) required" });

  const serverConfig = command
    ? { command, args: args || [], env: env || {} }
    : { url, transport: transport || undefined, env: env || {} };

  try {
    const result = await mcpManager.addServer(name, serverConfig);
    res.status(201).json({ message: result, name });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove an MCP server
app.delete("/mcp/:name", async (req, res) => {
  try {
    const result = await mcpManager.removeServer(req.params.name);
    res.json({ message: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Enable / disable / reload an MCP server
app.post("/mcp/:name/:action", async (req, res) => {
  const { name, action } = req.params;
  try {
    let result;
    if (action === "enable")   result = await mcpManager.setEnabled(name, true);
    else if (action === "disable") result = await mcpManager.setEnabled(name, false);
    else if (action === "reload")  result = await mcpManager.reloadServer(name);
    else return res.status(400).json({ error: `Unknown action: ${action}. Valid: enable, disable, reload` });
    res.json({ message: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Daemon endpoints ---
app.get("/daemon/status", (req, res) => {
  res.json(daemonManager.status());
});

app.post("/daemon/:action", (req, res) => {
  const { action } = req.params;
  try {
    switch (action) {
      case "install":
        daemonManager.install();
        res.json({ message: "Daemon installed. Will auto-start on boot." });
        break;
      case "uninstall":
        daemonManager.uninstall();
        res.json({ message: "Daemon uninstalled." });
        break;
      case "start":
        daemonManager.start();
        res.json({ message: "Daemon started." });
        break;
      case "stop":
        daemonManager.stop();
        res.json({ message: "Daemon stopped." });
        break;
      case "restart":
        daemonManager.restart();
        res.json({ message: "Daemon restarted." });
        break;
      default:
        res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Vault endpoints ---
app.get("/vault/status", (req, res) => {
  res.json({
    exists: secretVault.exists(),
    unlocked: secretVault.isUnlocked(),
  });
});

app.post("/vault/unlock", (req, res) => {
  try {
    const { passphrase } = req.body;
    if (!passphrase) return res.status(400).json({ error: "passphrase is required" });
    secretVault.unlock(passphrase);
    // Inject vault secrets into process.env for model adapters
    const secrets = secretVault.getAsEnv();
    for (const [key, value] of Object.entries(secrets)) {
      process.env[key] = value;
    }
    res.json({ message: "Vault unlocked", secretCount: Object.keys(secrets).length });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/vault/lock", (req, res) => {
  secretVault.lock();
  res.json({ message: "Vault locked" });
});

// --- Tenant endpoints ---
app.get("/tenants", (req, res) => {
  const tenants = tenantManager.list();
  res.json({ tenants, stats: tenantManager.stats() });
});

app.get("/tenants/:id", (req, res) => {
  const tenant = tenantManager.get(decodeURIComponent(req.params.id));
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });
  res.json(tenant);
});

app.patch("/tenants/:id", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const updated = tenantManager.set(id, req.body);
  res.json(updated);
});

app.post("/tenants/:id/suspend", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const { reason } = req.body;
  const updated = tenantManager.suspend(id, reason || "");
  if (!updated) return res.status(404).json({ error: "Tenant not found" });
  res.json(updated);
});

app.post("/tenants/:id/unsuspend", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const updated = tenantManager.unsuspend(id);
  if (!updated) return res.status(404).json({ error: "Tenant not found" });
  res.json(updated);
});

app.post("/tenants/:id/reset", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const updated = tenantManager.reset(id);
  if (!updated) return res.status(404).json({ error: "Tenant not found" });
  res.json(updated);
});

app.delete("/tenants/:id", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const deleted = tenantManager.delete(id);
  if (!deleted) return res.status(404).json({ error: "Tenant not found" });
  res.json({ message: "Tenant deleted" });
});

// --- Costs endpoint ---
app.get("/costs/today", (req, res) => {
  res.json({
    date: new Date().toISOString().split("T")[0],
    totalCost: getTodayCost(),
    dailyLimit: config.maxDailyCost,
    remaining: Math.max(0, config.maxDailyCost - getTodayCost()),
  });
});

// --- Start server ---
app.listen(config.port, async () => {
  console.log("\n--- Daemora Server ---");
  console.log(`Running on http://localhost:${config.port}`);
  console.log(`Model: ${config.defaultModel}`);
  console.log(`Permission tier: ${config.permissionTier}`);
  console.log(`Tools loaded: ${Object.keys(toolFunctions).join(", ")}`);
  console.log(`Total tools: ${Object.keys(toolFunctions).length}`);
  console.log(`Data dir: ${config.dataDir}`);
  console.log(`Daemon mode: ${config.daemonMode}`);
  console.log(`Task runner: active (concurrency: 2)`);

  // Initialize MCP in background
  mcpManager.init().catch((e) => console.log(`[MCPManager] Init error: ${e.message}`));

  // Start channels (await so we see results before the blank line)
  try {
    await channelRegistry.startAll();
  } catch (e) {
    console.log(`[ChannelRegistry] Start error: ${e.message}`);
  }
  console.log("");
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("\n[Shutdown] SIGTERM received. Stopping...");
  scheduler.stop();
  heartbeat.stop();
  taskRunner.stop();
  supervisor.stop();
  mcpManager.shutdown().then(() =>
    channelRegistry.stopAll().then(() => process.exit(0))
  );
});

process.on("SIGINT", () => {
  console.log("\n[Shutdown] SIGINT received. Stopping...");
  scheduler.stop();
  heartbeat.stop();
  taskRunner.stop();
  supervisor.stop();
  mcpManager.shutdown().then(() =>
    channelRegistry.stopAll().then(() => process.exit(0))
  );
});
