import express from "express";
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { toolFunctions } from "./tools/index.js";
import { getSession, listSessions, createSession, clearSession } from "./services/sessions.js";
import { config } from "./config/default.js";
import { listAvailableModels } from "./models/ModelRouter.js";
import taskQueue from "./core/TaskQueue.js";
import taskRunner from "./core/TaskRunner.js";
import { loadTask, listTasks, listChildTasks } from "./storage/TaskStore.js";
import { getTodayCost } from "./core/CostTracker.js";
import supervisor from "./agents/Supervisor.js";
import { getActiveSubAgentCount, listActiveAgents } from "./agents/SubAgentManager.js";
import eventBus from "./core/EventBus.js";
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
import { runCleanup } from "./services/cleanup.js";
import webhookHandler from "./webhooks/WebhookHandler.js";
import execApproval from "./safety/ExecApproval.js";
import openaiCompat from "./api/openai-compat.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// Auto-cleanup old data on startup
if (config.cleanupAfterDays > 0) {
  const cleaned = runCleanup(config.cleanupAfterDays);
  if (cleaned.total > 0) {
    console.log(`[Cleanup] Deleted ${cleaned.total} file(s) older than ${config.cleanupAfterDays} days (tasks: ${cleaned.tasks}, audit: ${cleaned.audit}, costs: ${cleaned.costs}, sessions: ${cleaned.sessions})`);
  }
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

// Mount webhook triggers (external integrations, CI/CD, GitHub webhooks)
app.use("/hooks", webhookHandler);

// Mount OpenAI-compatible API (gated by OPENAI_COMPAT_ENABLED)
if (process.env.OPENAI_COMPAT_ENABLED === "true") {
  app.use("/v1", openaiCompat);
  console.log("[Server] OpenAI-compatible API enabled at /v1/chat/completions");
}

// --- Security middleware ---
const localOnly = (req, res, next) => {
  const remoteAddress = req.socket.remoteAddress;
  // Support both IPv4 and IPv6 localhost
  if (remoteAddress === "127.0.0.1" || remoteAddress === "::ffff:127.0.0.1" || remoteAddress === "::1") {
    next();
  } else {
    console.warn(`[Security] Blocked non-local request from ${remoteAddress}`);
    res.status(403).json({ error: "Access denied. Only local requests are allowed." });
  }
};

// Apply local-only security to all API routes
app.use("/api", localOnly);

// --- Health check ---
app.get("/api/health", (req, res) => {
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

// --- Chat endpoint (Async — returns taskId, client uses SSE to stream) ---
app.post("/api/chat", (req, res) => {
  try {
    const { input, sessionId, model, priority, tenantId } = req.body;
    if (!input) return res.status(400).json({ error: "input is required" });

    const task = taskQueue.enqueue({
      input,
      channel: "http",
      sessionId: sessionId || "local-user",
      tenantId: tenantId || "http:local",
      model,
      priority: priority || 5,
      type: "chat",
    });

    res.status(202).json({
      taskId: task.id,
      sessionId: task.sessionId,
      status: "queued",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Task submit endpoint (Async) ---
app.post("/api/tasks", (req, res) => {
  try {
    const { input, sessionId, model, priority } = req.body;
    if (!input) return res.status(400).json({ error: "input is required" });

    const task = taskQueue.enqueue({
      input,
      channel: "http",
      sessionId: sessionId || "local-user",
      model,
      priority: priority || 5,
    });

    res.status(202).json({
      message: "Task enqueued",
      taskId: task.id,
      status: task.status,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/tasks/:id", (req, res) => {
  const task = loadTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }
  res.json(task);
});

app.get("/api/tasks", (req, res) => {
  const { limit, status, type } = req.query;
  const tasks = listTasks({
    limit: limit ? parseInt(limit, 10) : 20,
    status: status || null,
    type: type || null,
  });
  res.json({
    tasks: tasks.map((t) => ({
      id: t.id,
      status: t.status,
      type: t.type || "chat",
      title: t.title || null,
      channel: t.channel,
      input: t.input?.slice(0, 100) || "",
      cost: t.cost,
      parentTaskId: t.parentTaskId || null,
      agentId: t.agentId || null,
      agentCreated: t.agentCreated || false,
      subAgents: t.subAgents || null,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    })),
    queue: taskQueue.stats(),
  });
});

// --- Child tasks endpoint ---
app.get("/api/tasks/:id/children", (req, res) => {
  const children = listChildTasks(req.params.id);
  res.json({
    parentTaskId: req.params.id,
    children: children.map((t) => ({
      id: t.id,
      status: t.status,
      type: t.type || "chat",
      title: t.title || null,
      input: t.input?.slice(0, 100) || "",
      agentId: t.agentId || null,
      cost: t.cost,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    })),
  });
});

// --- Session endpoints ---
app.get("/api/sessions", (req, res) => {
  const sessionIds = listSessions();
  const sessionList = sessionIds.map(id => {
    const s = getSession(id);
    return {
      sessionId: s.sessionId,
      createdAt: s.createdAt,
      lastMessage: s.messages.length > 0 ? s.messages[s.messages.length - 1].content.slice(0, 50) : "Empty chat",
      messageCount: s.messages.length
    };
  }).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  
  res.json({ sessions: sessionList });
});

app.post("/api/sessions", (req, res) => {
  const session = createSession();
  res.status(201).json(session);
});

app.get("/api/sessions/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }
  // Filter out any leaked tool_call / tool_result messages
  const cleanMessages = (session.messages || []).filter(msg => {
    if (!msg.content || typeof msg.content !== "string") return false;
    if (msg.role !== "user" && msg.role !== "assistant") return false;
    const trimmed = msg.content.trimStart();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.type === "tool_call" || parsed.tool_call) return false;
        if (parsed.tool_name) return false;
        if (parsed.type === "text" && parsed.finalResponse !== undefined) return false;
      } catch { /* not JSON, keep it */ }
    }
    return true;
  });
  res.json({ ...session, messages: cleanMessages });
});

app.delete("/api/sessions/:id", (req, res) => {
  const deleted = clearSession(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: "Session not found" });
  }
  res.json({ message: "Session deleted" });
});

// --- Config endpoint ---
app.get("/api/config", (req, res) => {
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
app.get("/api/models", (req, res) => {
  const available = listAvailableModels();
  res.json({
    default: config.defaultModel,
    available: available.map(m => ({
      ...m,
      pricingPerMTok: m.costPer1kInput > 0 ? {
        input: `$${(m.costPer1kInput * 1000).toFixed(2)}`,
        output: `$${(m.costPer1kOutput * 1000).toFixed(2)}`,
      } : { input: "$0", output: "$0" },
    })),
  });
});

// --- Model switch endpoint ---
app.post("/api/model", (req, res) => {
  const { model } = req.body;
  if (!model) return res.status(400).json({ error: "model is required" });

  const available = listAvailableModels();
  const match = available.find(m => m.id === model);
  if (!match) {
    return res.status(400).json({
      error: `Unknown or unavailable model: ${model}`,
      available: available.map(m => m.id),
    });
  }

  config.defaultModel = model;
  res.json({ message: `Default model set to ${model}`, model });
});

// --- Supervisor endpoint ---
app.get("/api/supervisor", (req, res) => {
  res.json({
    warnings: supervisor.getWarnings(),
    activeSubAgents: getActiveSubAgentCount(),
  });
});

// --- Sub-agents endpoint ---
app.get("/api/subagents", (req, res) => {
  res.json({ agents: listActiveAgents() });
});

// --- SSE streaming endpoint for task events ---
app.get("/api/tasks/:id/stream", (req, res) => {
  const taskId = req.params.id;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Send current state immediately
  const task = loadTask(taskId);
  if (task) send("task:state", task);

  const onTool = (evt) => {
    if (evt.taskId === taskId) send("tool:after", evt);
  };
  const onModel = (evt) => {
    if (evt.taskId === taskId || evt.taskId?.startsWith("subagent-")) send("model:called", evt);
  };
  const onAgentSpawn = (evt) => {
    if (evt.parentTaskId === taskId) send("agent:spawned", evt);
  };
  const onAgentDone = (evt) => {
    if (evt.parentTaskId === taskId) send("agent:finished", evt);
  };
  const onComplete = (evt) => {
    if (evt.taskId === taskId) {
      const finalTask = loadTask(taskId);
      send("task:completed", finalTask || evt);
      cleanup();
      res.end();
    }
  };
  const onFail = (evt) => {
    if (evt.taskId === taskId) {
      send("task:failed", evt);
      cleanup();
      res.end();
    }
  };

  eventBus.on("tool:after", onTool);
  eventBus.on("model:called", onModel);
  eventBus.on("agent:spawned", onAgentSpawn);
  eventBus.on("agent:finished", onAgentDone);
  eventBus.on("task:completed", onComplete);
  eventBus.on("task:failed", onFail);

  const cleanup = () => {
    eventBus.removeListener("tool:after", onTool);
    eventBus.removeListener("model:called", onModel);
    eventBus.removeListener("agent:spawned", onAgentSpawn);
    eventBus.removeListener("agent:finished", onAgentDone);
    eventBus.removeListener("task:completed", onComplete);
    eventBus.removeListener("task:failed", onFail);
  };

  req.on("close", cleanup);
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
app.get("/api/channels", (req, res) => {
  res.json({ channels: channelRegistry.list() });
});

// --- Skills endpoint ---
app.get("/api/skills", (req, res) => {
  res.json({ skills: skillLoader.list() });
});

app.post("/api/skills/reload", (req, res) => {
  skillLoader.reload();
  res.json({ message: "Skills reloaded", skills: skillLoader.list() });
});

// --- Schedule endpoints ---
app.post("/api/schedules", (req, res) => {
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

app.get("/api/schedules", (req, res) => {
  res.json({ schedules: scheduler.list() });
});

app.delete("/api/schedules/:id", (req, res) => {
  scheduler.delete(req.params.id);
  res.json({ message: "Schedule deleted" });
});

// --- Audit endpoint ---
app.get("/api/audit", (req, res) => {
  res.json(auditLog.stats());
});

// --- MCP endpoints ---
app.get("/api/mcp", (req, res) => {
  const cfg = mcpManager.readConfig().mcpServers || {};
  const live = mcpManager.list();
  const isPlaceholder = (v) => !v || v.startsWith("YOUR_") || v === "" || v.startsWith("${");
  const servers = Object.entries(cfg)
    .filter(([k]) => !k.startsWith("_comment"))
    .map(([name, serverCfg]) => {
      const liveEntry = live.find(s => s.name === name);
      // Check if any env/header values are unconfigured placeholders
      const envEntries = serverCfg.env ? Object.entries(serverCfg.env) : [];
      const headerEntries = serverCfg.headers ? Object.entries(serverCfg.headers) : [];
      const needsConfig = envEntries.some(([, v]) => isPlaceholder(v)) || headerEntries.some(([, v]) => isPlaceholder(v));
      return {
        name,
        enabled: serverCfg.enabled !== false,
        connected: liveEntry?.connected ?? false,
        tools: liveEntry?.tools ?? [],
        type: serverCfg.command ? "stdio" : (serverCfg.transport || "http"),
        command: serverCfg.command || null,
        url: serverCfg.url || null,
        description: serverCfg.description || null,
        envKeys: serverCfg.env ? Object.keys(serverCfg.env) : [],
        headerKeys: serverCfg.headers ? Object.keys(serverCfg.headers) : [],
        needsConfig,
      };
    });
  res.json({ servers });
});

// Add a new MCP server
app.post("/api/mcp", async (req, res) => {
  const { name, command, args, url, transport, env, headers, description } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  if (!command && !url) return res.status(400).json({ error: "command (stdio) or url (http/sse) required" });

  const serverConfig = command
    ? { command, args: args || [], ...(env && Object.keys(env).length > 0 ? { env } : {}) }
    : { url, ...(transport ? { transport } : {}), ...(headers && Object.keys(headers).length > 0 ? { headers } : {}) };
  if (description) serverConfig.description = description;

  try {
    const result = await mcpManager.addServer(name, serverConfig);
    res.status(201).json({ message: result, name });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove an MCP server
app.delete("/api/mcp/:name", async (req, res) => {
  try {
    const result = await mcpManager.removeServer(req.params.name);
    res.json({ message: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update MCP server credentials (env vars or headers)
app.patch("/api/mcp/:name", async (req, res) => {
  const { name } = req.params;
  const { env, headers: hdrs } = req.body;
  try {
    const mcpConfig = mcpManager.readConfig();
    const serverCfg = mcpConfig.mcpServers?.[name];
    if (!serverCfg) return res.status(404).json({ error: `Server "${name}" not found` });

    if (env && typeof env === "object") {
      serverCfg.env = { ...(serverCfg.env || {}), ...env };
    }
    if (hdrs && typeof hdrs === "object") {
      serverCfg.headers = { ...(serverCfg.headers || {}), ...hdrs };
    }
    mcpConfig.mcpServers[name] = serverCfg;
    mcpManager.writeConfig(mcpConfig);
    res.json({ message: `Credentials updated for "${name}"` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Enable / disable / reload an MCP server
app.post("/api/mcp/:name/:action", async (req, res) => {
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
app.get("/api/daemon/status", (req, res) => {
  res.json(daemonManager.status());
});

app.post("/api/daemon/:action", (req, res) => {
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
app.get("/api/vault/status", (req, res) => {
  res.json({
    exists: secretVault.exists(),
    unlocked: secretVault.isUnlocked(),
  });
});

app.post("/api/vault/unlock", (req, res) => {
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

app.post("/api/vault/lock", (req, res) => {
  secretVault.lock();
  res.json({ message: "Vault locked" });
});

// --- Tenant endpoints ---
app.get("/api/tenants", (req, res) => {
  const tenants = tenantManager.list();
  res.json({ tenants, stats: tenantManager.stats() });
});

app.get("/api/tenants/:id", (req, res) => {
  const tenant = tenantManager.get(decodeURIComponent(req.params.id));
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });
  res.json(tenant);
});

app.patch("/api/tenants/:id", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const updated = tenantManager.set(id, req.body);
  res.json(updated);
});

app.post("/api/tenants/:id/suspend", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const { reason } = req.body;
  const updated = tenantManager.suspend(id, reason || "");
  if (!updated) return res.status(404).json({ error: "Tenant not found" });
  res.json(updated);
});

app.post("/api/tenants/:id/unsuspend", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const updated = tenantManager.unsuspend(id);
  if (!updated) return res.status(404).json({ error: "Tenant not found" });
  res.json(updated);
});

app.post("/api/tenants/:id/reset", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const updated = tenantManager.reset(id);
  if (!updated) return res.status(404).json({ error: "Tenant not found" });
  res.json(updated);
});

app.delete("/api/tenants/:id", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const deleted = tenantManager.delete(id);
  if (!deleted) return res.status(404).json({ error: "Tenant not found" });
  res.json({ message: "Tenant deleted" });
});

// --- Exec approvals ---
app.get("/api/approvals", (req, res) => {
  res.json({ approvals: execApproval.listPending(), mode: execApproval.mode });
});

app.post("/api/approvals/:id", (req, res) => {
  const { decision } = req.body;
  if (!["allow", "allow-once", "deny"].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "allow", "allow-once", or "deny"' });
  }
  const resolved = execApproval.resolveApproval(req.params.id, decision);
  if (!resolved) return res.status(404).json({ error: "Approval not found or expired" });
  res.json({ message: `Approval ${req.params.id} → ${decision}` });
});

// --- Settings endpoint (read/write .env vars) ---
app.get("/api/settings", (req, res) => {
  const envPath = join(__dirname, "..", ".env");
  const examplePath = join(__dirname, "..", ".env.example");

  // Parse current .env
  const envVars = {};
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      envVars[key] = val;
    }
  }

  // Parse .env.example for available vars with sections
  const available = [];
  if (existsSync(examplePath)) {
    const lines = readFileSync(examplePath, "utf-8").split("\n");
    let section = "General";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("# ===")) {
        section = trimmed.replace(/^# =+\s*/, "").replace(/\s*=+$/, "");
        continue;
      }
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      available.push({ key, section });
    }
  }

  // Mask values for security
  const masked = {};
  for (const [key, val] of Object.entries(envVars)) {
    if (!val) { masked[key] = ""; continue; }
    masked[key] = val.length <= 4 ? "****" : val.slice(0, 4) + "*".repeat(Math.min(val.length - 4, 20));
  }

  res.json({ vars: masked, available });
});

app.put("/api/settings", (req, res) => {
  const { updates } = req.body; // { KEY: "value", KEY2: "value2" }
  if (!updates || typeof updates !== "object") {
    return res.status(400).json({ error: "updates object is required" });
  }

  const envPath = join(__dirname, "..", ".env");
  let content = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";

  for (const [key, value] of Object.entries(updates)) {
    // Validate key format (alphanumeric + underscore only)
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    const regex = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
    // Also update process.env so changes take effect without restart
    process.env[key] = value;
  }

  writeFileSync(envPath, content, "utf-8");

  res.json({ message: `Updated ${Object.keys(updates).length} variable(s)`, updated: Object.keys(updates) });
});

// --- User Profile endpoints ---
app.get("/api/profile", (req, res) => {
  const profilePath = join(config.dataDir, "user-profile.json");
  if (!existsSync(profilePath)) return res.json({});
  try {
    const profile = JSON.parse(readFileSync(profilePath, "utf-8"));
    res.json(profile);
  } catch {
    res.json({});
  }
});

app.put("/api/profile", (req, res) => {
  const { name, personality, tone, instructions } = req.body;
  const profilePath = join(config.dataDir, "user-profile.json");
  const profile = { name: name || "", personality: personality || "", tone: tone || "", instructions: instructions || "" };
  mkdirSync(dirname(profilePath), { recursive: true });
  writeFileSync(profilePath, JSON.stringify(profile, null, 2), "utf-8");
  res.json({ message: "Profile saved", profile });
});

// --- Custom Skills endpoints ---
app.get("/api/skills/custom", (req, res) => {
  const customDir = join(config.skillsDir, "custom");
  if (!existsSync(customDir)) return res.json({ skills: [] });
  const files = [];
  try {
    const entries = readdirSync(customDir);
    for (const f of entries) {
      if (!f.endsWith(".md")) continue;
      const content = readFileSync(join(customDir, f), "utf-8");
      // Parse frontmatter
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      const meta = {};
      if (fmMatch) {
        for (const line of fmMatch[1].split("\n")) {
          const idx = line.indexOf(":");
          if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
      }
      files.push({
        name: meta.name || f.replace(".md", ""),
        description: meta.description || "",
        triggers: meta.triggers || "",
        filename: f,
        content: fmMatch ? fmMatch[2].trim() : content,
      });
    }
  } catch { /* ignore */ }
  res.json({ skills: files });
});

app.post("/api/skills/custom", (req, res) => {
  const { name, description, triggers, content } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  if (!content) return res.status(400).json({ error: "content is required" });

  // Sanitize filename
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const customDir = join(config.skillsDir, "custom");
  mkdirSync(customDir, { recursive: true });

  const filePath = join(customDir, `${safeName}.md`);
  const frontmatter = `---\nname: ${safeName}\ndescription: ${description || ""}\n${triggers ? `triggers: ${triggers}\n` : ""}---\n\n`;
  writeFileSync(filePath, frontmatter + content, "utf-8");

  // Reload skills so new skill is discoverable
  skillLoader.reload();

  res.status(201).json({ message: "Custom skill created", name: safeName });
});

app.delete("/api/skills/custom/:name", (req, res) => {
  const safeName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const filePath = join(config.skillsDir, "custom", `${safeName}.md`);
  if (!existsSync(filePath)) return res.status(404).json({ error: "Skill not found" });

  unlinkSync(filePath);
  skillLoader.reload();
  res.json({ message: "Custom skill deleted" });
});

// --- Memory endpoints ---
app.get("/api/memory", (req, res) => {
  const memoryPath = config.memoryPath;
  if (!existsSync(memoryPath)) return res.json({ content: "" });
  try {
    const content = readFileSync(memoryPath, "utf-8");
    res.json({ content });
  } catch {
    res.json({ content: "" });
  }
});

app.put("/api/memory", (req, res) => {
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: "content is required" });
  writeFileSync(config.memoryPath, content, "utf-8");
  res.json({ message: "Memory saved" });
});

// --- Costs endpoint ---
app.get("/api/costs/today", (req, res) => {
  res.json({
    date: new Date().toISOString().split("T")[0],
    totalCost: getTodayCost(),
    dailyLimit: config.maxDailyCost,
    remaining: Math.max(0, config.maxDailyCost - getTodayCost()),
  });
});

// --- Static UI ---
const uiPath = join(__dirname, "..", "daemora-ui", "dist");
if (existsSync(uiPath)) {
  app.use(express.static(uiPath));
  // Serve index.html for all other routes (React Router support)
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/webhooks/") || req.path.startsWith("/voice/") || req.path.startsWith("/a2a/") || req.path.startsWith("/hooks/") || req.path.startsWith("/v1/")) {
      return next();
    }
    res.sendFile(join(uiPath, "index.html"));
  });
  console.log(`[Server] Serving UI from ${uiPath}`);
}

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
