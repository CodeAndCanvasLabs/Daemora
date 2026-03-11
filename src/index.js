import express from "express";
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";
import { toolFunctions } from "./tools/index.js";
import { getSession, listSessions, createSession, clearSession } from "./services/sessions.js";
import { config } from "./config/default.js";
import { listAvailableModels } from "./models/ModelRouter.js";
import taskQueue from "./core/TaskQueue.js";
import taskRunner from "./core/TaskRunner.js";
import { loadTask, listTasks, listChildTasks, deleteTask } from "./storage/TaskStore.js";
import { getTodayCost } from "./core/CostTracker.js";
import supervisor from "./agents/Supervisor.js";
import { getActiveSubAgentCount, listActiveAgents } from "./agents/SubAgentManager.js";
import eventBus from "./core/EventBus.js";
import channelRegistry from "./channels/index.js";
import { CHANNEL_DEFS, isChannelConfigured } from "./channels/channelDefs.js";
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
import { msgText } from "./utils/msgText.js";
import { configStore } from "./config/ConfigStore.js";

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

// Initialize task system (TaskRunner starts after full init — see startup sequence below)
taskQueue.init();
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

// Security headers on all responses
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

// Localhost-only: reject non-local IP addresses
const localOnly = (req, res, next) => {
  const remoteAddress = req.socket.remoteAddress;
  if (remoteAddress === "127.0.0.1" || remoteAddress === "::ffff:127.0.0.1" || remoteAddress === "::1") {
    next();
  } else {
    console.warn(`[Security] Blocked non-local request from ${remoteAddress}`);
    res.status(403).json({ error: "Access denied. Only local requests are allowed." });
  }
};

// Origin validation: block DNS rebinding and cross-origin browser attacks.
// Browsers always send Origin on cross-origin requests. A malicious page on
// evil.com making fetch("http://localhost:8081/api/...") will have Origin: https://evil.com
// which we reject. Same-origin requests from our UI have no Origin or matching localhost.
const originGuard = (req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next(); // Same-origin requests (no Origin header) — safe

  // Allow only our own localhost origins
  const allowedOrigins = [
    `http://localhost:${config.port}`,
    `http://127.0.0.1:${config.port}`,
    `http://[::1]:${config.port}`,
  ];
  // Also allow Vite dev server (common dev ports)
  for (const devPort of [5173, 5174, 3000, 3001]) {
    allowedOrigins.push(`http://localhost:${devPort}`);
    allowedOrigins.push(`http://127.0.0.1:${devPort}`);
  }

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    return next();
  }

  console.warn(`[Security] Blocked cross-origin request from ${origin}`);
  res.status(403).json({ error: "Cross-origin request blocked." });
};

// --- API Token auth ---
// Auto-generated on first start, stored on disk. Required for all /api/* requests.
// The UI receives the token via server-injected <meta> tag (no login needed).
// Other local tools (curl, scripts) read it from data/auth-token or pass via header.
const AUTH_TOKEN_PATH = join(config.dataDir, "auth-token");

function getOrCreateAuthToken() {
  if (existsSync(AUTH_TOKEN_PATH)) {
    const token = readFileSync(AUTH_TOKEN_PATH, "utf-8").trim();
    if (token.length >= 32) return token;
  }
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(AUTH_TOKEN_PATH), { recursive: true });
  writeFileSync(AUTH_TOKEN_PATH, token, { mode: 0o600 });
  console.log("[Security] Generated new API auth token");
  return token;
}

const API_TOKEN = getOrCreateAuthToken();

const tokenAuth = (req, res, next) => {
  // Health endpoint is public (monitoring/readiness probes)
  if (req.path === "/api/health") return next();

  // Check Authorization: Bearer <token> header
  const authHeader = req.headers.authorization;
  if (authHeader === `Bearer ${API_TOKEN}`) return next();

  // Check X-Auth-Token header (simpler for scripts/curl)
  if (req.headers["x-auth-token"] === API_TOKEN) return next();

  // Check ?token= query param (for SSE/EventSource which can't set headers)
  if (req.query.token === API_TOKEN) return next();

  console.warn(`[Security] Rejected unauthenticated request: ${req.method} ${req.path}`);
  res.status(401).json({ error: "Authentication required. Include Authorization: Bearer <token> header." });
};

// Apply security to all API routes: IP check → origin check → token auth
app.use("/api", localOnly);
app.use("/api", originGuard);
app.use("/api", tokenAuth);

// --- Health check ---
app.get("/api/health", (req, res) => {
  res.json({
    status: _serverReady ? "ok" : "starting",
    ready: _serverReady,
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

app.delete("/api/tasks/:id", (req, res) => {
  const id = req.params.id;
  // Refuse to delete a running task — cancel it first
  if (taskQueue.active.has(id)) {
    return res.status(409).json({ error: "Cannot delete a running task. Cancel it first." });
  }
  const deleted = deleteTask(id);
  if (!deleted) return res.status(404).json({ error: "Task not found" });
  res.json({ message: `Task ${id} deleted` });
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
      lastMessage: s.messages.length > 0 ? msgText(s.messages[s.messages.length - 1].content).slice(0, 50) || "Empty chat" : "Empty chat",
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
  // Filter out any leaked tool_call / tool_result messages and normalize content
  const cleanMessages = (session.messages || []).filter(msg => {
    if (msg.role !== "user" && msg.role !== "assistant") return false;
    const text = msgText(msg.content);
    if (!text) return false;
    msg.content = text;
    const trimmed = text.trimStart();
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

app.get("/api/channels/defs", (req, res) => {
  const running = channelRegistry.list();
  const runningMap = Object.fromEntries(running.map(ch => [ch.name, ch.running]));
  res.json({
    channels: CHANNEL_DEFS.map(ch => ({
      name: ch.name,
      label: ch.label,
      desc: ch.desc,
      tenantKey: ch.tenantKey,
      envRequired: ch.envRequired,
      envOptional: ch.envOptional,
      setup: ch.setup,
      prompts: ch.prompts,
      configured: isChannelConfigured(ch),
      running: !!runningMap[ch.name],
    })),
  });
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
  // Detect placeholder patterns in command args (e.g. connection strings, paths with dummy values)
  const isArgPlaceholder = (v) => {
    if (typeof v !== "string") return false;
    return /user:pass@/i.test(v) || /\/Users\/you\//i.test(v) || /YOUR_/i.test(v)
      || /your-.*-here/i.test(v) || /example\.com/i.test(v) || /changeme/i.test(v)
      || /placeholder/i.test(v) || /xxx/i.test(v);
  };
  const servers = Object.entries(cfg)
    .filter(([k]) => !k.startsWith("_comment"))
    .map(([name, serverCfg]) => {
      const liveEntry = live.find(s => s.name === name);
      // Check if any env/header values are unconfigured placeholders
      const envEntries = serverCfg.env ? Object.entries(serverCfg.env) : [];
      const headerEntries = serverCfg.headers ? Object.entries(serverCfg.headers) : [];
      // Also check args for placeholder patterns
      const args = serverCfg.args || [];
      const placeholderArgs = args
        .map((v, i) => isArgPlaceholder(v) ? { index: i, value: v } : null)
        .filter(Boolean);
      const needsConfig = envEntries.some(([, v]) => isPlaceholder(v))
        || headerEntries.some(([, v]) => isPlaceholder(v))
        || placeholderArgs.length > 0;
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
        placeholderArgs,
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
  const { env, headers: hdrs, args: argUpdates } = req.body;
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
    // Support updating specific args by index (e.g. connection strings)
    if (argUpdates && typeof argUpdates === "object") {
      if (!serverCfg.args) serverCfg.args = [];
      for (const [indexStr, value] of Object.entries(argUpdates)) {
        const idx = parseInt(indexStr, 10);
        if (!isNaN(idx) && idx >= 0 && idx < serverCfg.args.length) {
          serverCfg.args[idx] = value;
        }
      }
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
  const tenants = tenantManager.list().map(t => ({
    ...t,
    channels: tenantManager.getChannels(t.id),
  }));
  res.json({ tenants, stats: tenantManager.stats() });
});

app.post("/api/tenants", (req, res) => {
  const { channel, userId, plan, notes } = req.body || {};
  if (!channel || !userId) return res.status(400).json({ error: "channel and userId are required" });
  const existing = tenantManager.getOrCreate(channel, userId);
  if (existing) {
    if (plan || notes) tenantManager.set(existing.id, { ...(plan && { plan }), ...(notes && { notes }) });
    return res.json({ tenant: tenantManager.get(existing.id), created: true });
  }
  res.status(500).json({ error: "Auto-register is disabled" });
});

app.get("/api/tenants/:id", (req, res) => {
  const tenant = tenantManager.get(decodeURIComponent(req.params.id));
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });
  res.json(tenant);
});

app.patch("/api/tenants/:id", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  try {
    const updated = tenantManager.set(id, req.body);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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

// --- Tenant API keys ---
app.get("/api/tenants/:id/apikeys", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const keys = tenantManager.listApiKeyNames(id);
  res.json({ keys });
});

app.put("/api/tenants/:id/apikeys/:keyName", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const keyName = decodeURIComponent(req.params.keyName);
  const { value } = req.body || {};
  if (!value || typeof value !== "string" || value.length < 4) {
    return res.status(400).json({ error: "value is required (min 4 chars)" });
  }
  tenantManager.setApiKey(id, keyName, value);
  res.json({ message: `API key ${keyName} saved` });
});

app.delete("/api/tenants/:id/apikeys/:keyName", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const keyName = decodeURIComponent(req.params.keyName);
  const deleted = tenantManager.deleteApiKey(id, keyName);
  if (!deleted) return res.status(404).json({ error: "Key not found" });
  res.json({ message: `API key ${keyName} deleted` });
});

// --- Tenant channel identities ---
app.get("/api/tenants/:id/channels", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  if (!tenantManager.get(id)) return res.status(404).json({ error: "Tenant not found" });
  res.json({ channels: tenantManager.getChannels(id) });
});

app.post("/api/tenants/:id/channels", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const { channel, userId } = req.body || {};
  if (!channel || !userId) return res.status(400).json({ error: "channel and userId are required" });
  try {
    tenantManager.linkChannel(id, channel, userId);
    res.json({ message: `Linked ${channel}:${userId} to tenant ${id}` });
  } catch (err) {
    const status = err.message.includes("not found") ? 404 : 409;
    res.status(status).json({ error: err.message });
  }
});

app.delete("/api/tenants/:id/channels/:channel/:userId", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const channel = req.params.channel;
  const userId = decodeURIComponent(req.params.userId);
  try {
    tenantManager.unlinkChannel(id, channel, userId);
    res.json({ message: `Unlinked ${channel}:${userId} from tenant ${id}` });
  } catch (err) {
    const status = err.message.includes("last channel") ? 400 : 404;
    res.status(status).json({ error: err.message });
  }
});

// --- Tenant-owned MCP servers ---

app.get("/api/tenants/:id/mcp-servers", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  if (!tenantManager.get(id)) return res.status(404).json({ error: "Tenant not found" });
  res.json({ mcpServers: tenantManager.getOwnMcpServers(id) });
});

app.post("/api/tenants/:id/mcp-servers", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const { name, serverConfig } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required" });
  if (!serverConfig || (!serverConfig.command && !serverConfig.url)) {
    return res.status(400).json({ error: "serverConfig must have 'command' (stdio) or 'url' (http/sse)" });
  }
  try {
    const result = tenantManager.addOwnMcpServer(id, name, serverConfig);
    res.json(result);
  } catch (err) {
    const status = err.message.includes("not found") ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

app.delete("/api/tenants/:id/mcp-servers/:name", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const name = req.params.name;
  const removed = tenantManager.removeOwnMcpServer(id, name);
  if (!removed) return res.status(404).json({ error: `Server "${name}" not found for tenant` });
  res.json({ message: `Removed MCP server "${name}" from tenant ${id}` });
});

// --- Per-tenant channel credentials ---

app.get("/api/tenants/:id/channel-config", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  if (!tenantManager.get(id)) return res.status(404).json({ error: "Tenant not found" });
  const keys = tenantManager.listChannelConfigKeys(id);
  res.json({ keys });
});

app.put("/api/tenants/:id/channel-config/:key", async (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const key = req.params.key;
  const { value } = req.body || {};
  if (!value) return res.status(400).json({ error: "value is required" });
  if (!tenantManager.get(id)) return res.status(404).json({ error: "Tenant not found" });
  tenantManager.setChannelConfig(id, key, value);
  // Live-reload channels for this tenant
  const creds = tenantManager.getDecryptedChannelConfig(id);
  await channelRegistry.reloadTenantChannels(id, creds);
  res.json({ ok: true, key });
});

app.delete("/api/tenants/:id/channel-config/:key", async (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const key = req.params.key;
  if (!tenantManager.get(id)) return res.status(404).json({ error: "Tenant not found" });
  const removed = tenantManager.deleteChannelConfig(id, key);
  if (!removed) return res.status(404).json({ error: `Credential "${key}" not found` });
  // Live-reload channels for this tenant
  const creds = tenantManager.getDecryptedChannelConfig(id);
  await channelRegistry.reloadTenantChannels(id, creds);
  res.json({ ok: true });
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

// --- Settings endpoint (read/write config — .env + vault, SQLite config as overlay) ---
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

  // Overlay with SQLite config_entries (setup wizard writes here)
  const dbConfig = configStore.getAll();
  Object.assign(envVars, dbConfig);

  // Parse .env.example for available vars with sections (used for UI display grouping)
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

  // Merge vault secrets (if unlocked) — vault takes priority over config
  const vaultActive = secretVault.isUnlocked();
  if (vaultActive) {
    const vaultSecrets = secretVault.getAsEnv();
    for (const key of Object.keys(vaultSecrets)) {
      envVars[key] = vaultSecrets[key];
    }
  }

  // Uniform masking — never leak any characters
  const masked = {};
  for (const [key, val] of Object.entries(envVars)) {
    if (!val) { masked[key] = ""; continue; }
    masked[key] = "••••••••";
  }

  res.json({ vars: masked, available, vaultActive });
});

app.put("/api/settings", (req, res) => {
  const { updates } = req.body; // { KEY: "value", KEY2: "value2" }
  if (!updates || typeof updates !== "object") {
    return res.status(400).json({ error: "updates object is required" });
  }

  const vaultActive = secretVault.isUnlocked();
  const sensitivePattern = /KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL/i;

  // Separate sensitive vs non-sensitive
  const envUpdates = {};
  const vaultUpdates = {};

  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    if (vaultActive && sensitivePattern.test(key)) {
      vaultUpdates[key] = value;
    } else {
      envUpdates[key] = value;
    }
    // Always update process.env so changes take effect immediately
    process.env[key] = value;
  }

  // Write non-sensitive (or all if vault locked) to .env
  if (Object.keys(envUpdates).length > 0 || (!vaultActive && Object.keys(vaultUpdates).length === 0)) {
    const allEnvUpdates = vaultActive ? envUpdates : { ...envUpdates, ...vaultUpdates };
    const envPath = join(__dirname, "..", ".env");
    let content = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
    for (const [key, value] of Object.entries(allEnvUpdates)) {
      const regex = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`, "m");
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        content = content.trimEnd() + `\n${key}=${value}\n`;
      }
    }
    writeFileSync(envPath, content, "utf-8");
  }

  // Write sensitive keys to vault
  if (vaultActive && Object.keys(vaultUpdates).length > 0) {
    for (const [key, value] of Object.entries(vaultUpdates)) {
      secretVault.set(key, value);
    }
  }

  const stored = vaultActive
    ? { env: Object.keys(envUpdates), vault: Object.keys(vaultUpdates) }
    : { env: Object.keys(updates).filter(k => /^[A-Z][A-Z0-9_]*$/.test(k)) };

  res.json({ message: `Updated ${Object.keys(updates).length} variable(s)`, stored });
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
  const { name, personality, tone, instructions, subAgentModel } = req.body;
  const profilePath = join(config.dataDir, "user-profile.json");
  const profile = { name: name || "", personality: personality || "", tone: tone || "", instructions: instructions || "", subAgentModel: subAgentModel || "" };
  mkdirSync(dirname(profilePath), { recursive: true });
  writeFileSync(profilePath, JSON.stringify(profile, null, 2), "utf-8");
  // Apply sub-agent model to runtime so it takes effect immediately
  if (subAgentModel) {
    process.env.SUB_AGENT_MODEL = subAgentModel;
  } else {
    delete process.env.SUB_AGENT_MODEL;
  }
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

// --- Static UI (with auth token injection) ---
const uiPath = join(__dirname, "..", "daemora-ui", "dist");
if (existsSync(uiPath)) {
  const indexHtmlPath = join(uiPath, "index.html");
  let indexHtml = existsSync(indexHtmlPath) ? readFileSync(indexHtmlPath, "utf-8") : "";

  // Inject auth token as a <meta> tag so the UI can read it without a login flow.
  // Safe because the HTML is only served to localhost (localOnly middleware).
  const tokenMeta = `<meta name="api-token" content="${API_TOKEN}" />`;
  if (indexHtml && !indexHtml.includes('name="api-token"')) {
    indexHtml = indexHtml.replace("</head>", `    ${tokenMeta}\n  </head>`);
  }

  // Serve static assets normally
  app.use(express.static(uiPath, { index: false })); // index:false so we handle index.html ourselves

  // Serve token-injected index.html for all UI routes
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/webhooks/") || req.path.startsWith("/voice/") || req.path.startsWith("/a2a/") || req.path.startsWith("/hooks/") || req.path.startsWith("/v1/")) {
      return next();
    }
    res.setHeader("Content-Type", "text/html");
    res.send(indexHtml);
  });
  console.log(`[Server] Serving UI from ${uiPath}`);
}

// --- Load user profile settings on startup ---
try {
  const profilePath = join(config.dataDir, "user-profile.json");
  if (existsSync(profilePath)) {
    const p = JSON.parse(readFileSync(profilePath, "utf-8"));
    if (p.subAgentModel && !process.env.SUB_AGENT_MODEL) {
      process.env.SUB_AGENT_MODEL = p.subAgentModel;
    }
  }
} catch { /* ignore */ }

// --- Server readiness gate ---
// The server must fully initialize before processing user messages.
// Skills, MCP, embeddings, and channels all need to load first.
// Requests that arrive before ready get a 503 with a clear message.
let _serverReady = false;

// Gate message-processing endpoints until startup completes
const readinessGate = (req, res, next) => {
  if (_serverReady) return next();
  res.status(503).json({ error: "Server is starting up — loading skills, MCP, and channels. Please wait a moment and retry." });
};
app.use("/api/chat", readinessGate);
app.post("/api/tasks", readinessGate);

// --- Start server ---
app.listen(config.port, async () => {
  console.log("\n--- Daemora Server ---");
  console.log(`Running on http://localhost:${config.port}`);
  console.log(`Model: ${config.defaultModel}`);
  if (process.env.SUB_AGENT_MODEL) console.log(`Sub-agent model: ${process.env.SUB_AGENT_MODEL}`);
  console.log(`Permission tier: ${config.permissionTier}`);
  console.log(`Data dir: ${config.dataDir}`);
  console.log(`Daemon mode: ${config.daemonMode}`);

  // ── Phase 1: Load skills + embeddings (must complete before processing messages) ──
  console.log("[Startup] Loading skills...");
  skillLoader.load();
  console.log(`[Startup] Skills loaded: ${skillLoader.list().length}`);

  console.log("[Startup] Initializing embeddings...");
  try {
    const { ensureOllamaEmbedModel } = await import("./utils/Embeddings.js");
    await ensureOllamaEmbedModel();
  } catch { /* non-fatal */ }

  // Embed skills (uses whatever embedding provider is available)
  try {
    await skillLoader.embedSkills();
    console.log("[Startup] Skill embeddings ready");
  } catch { /* non-fatal — TF-IDF fallback always works */ }

  // ── Phase 2: Connect MCP servers ──
  console.log("[Startup] Connecting MCP servers...");
  try {
    await mcpManager.init();
  } catch (e) {
    console.log(`[Startup] MCP init error (non-fatal): ${e.message}`);
  }

  // ── Phase 3: Start channels ──
  console.log("[Startup] Starting channels...");
  try {
    await channelRegistry.startAll();
  } catch (e) {
    console.log(`[Startup] Channel start error: ${e.message}`);
  }

  // ── Ready — start processing messages ──
  taskRunner.start();
  console.log(`[Startup] Tools: ${Object.keys(toolFunctions).length}`);
  console.log(`[Startup] Task runner: active (concurrency: 2)`);
  _serverReady = true;
  console.log("[Startup] Server ready ✓\n");
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
