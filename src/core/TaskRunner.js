import { runAgentLoop } from "./AgentLoop.js";
import { buildSystemPrompt } from "../agents/systemPrompt.js";
import { toolFunctions } from "../tools/index.js";
import { CORE_TOOLS } from "../config/agentProfiles.js";
import { createSession, getSession, setMessages, appendMessage } from "../services/sessions.js";
import taskQueue from "./TaskQueue.js";
import { isDailyBudgetExceeded, isTenantDailyBudgetExceeded } from "./CostTracker.js";
import { config } from "../config/default.js";
import { resolveDefaultModel } from "../models/ModelRouter.js";
import tenantManager from "../tenants/TenantManager.js";
import tenantContext from "../tenants/TenantContext.js";
import inputSanitizer from "../safety/InputSanitizer.js";
import channelRegistry from "../channels/index.js";
import eventBus from "./EventBus.js";
import { msgText, compactForSession } from "../utils/msgText.js";
import { generateEmbedding, cosineSim } from "../utils/Embeddings.js";
import { writeDailyLog } from "../tools/memory.js";
import { queryAll } from "../storage/Database.js";

/**
 * Filter out internal tool call/result JSON from messages before saving to session.
 * Keeps only clean user text and assistant text that users should see.
 */
export function filterCleanMessages(messages) {
  return messages.filter(msg => {
    if (msg.role === "tool") return false;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      if (msg.content.some(p => p.type === "tool-call")) return false;
    }

    if (msg.role === "assistant") {
      const text = msgText(msg.content);
      if (!text) return false;
      msg.content = text;
      return true;
    }

    if (msg.role === "user") {
      const text = msgText(msg.content);
      if (!text) return false;
      msg.content = text;
      if (text.startsWith("[Supervisor instruction]:")) return false;
      if (text.startsWith("[System:")) return false;
      if (text.startsWith("[User follow-up while you are working")) return false;
      if (text.includes("You have used") && text.includes("iterations")) return false;
      return true;
    }

    return false;
  });
}

// ── Auto-capture: log task summaries after completion ────────────────────────
const _GREETING_PATTERN = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|yep|nope|bye|good morning|good evening|gm|gn)\s*[!.?]*$/i;

async function _autoCapture(task, result, resolvedConfig) {
  try {
    // Skip if disabled
    if (resolvedConfig.autoCapture === false) return;

    // Skip trivial inputs
    const input = task.input || "";
    if (input.length < 50) return;
    if (_GREETING_PATTERN.test(input.trim())) return;

    // Skip if no result
    const resultText = result.text || "";
    if (!resultText) return;

    // Build summary
    const toolNames = (result.toolCalls || []).map(tc => tc.tool || tc.name).filter(Boolean);
    const toolStr = toolNames.length > 0 ? ` | Tools: ${[...new Set(toolNames)].slice(0, 5).join(", ")}` : "";
    const summary = `User: ${input.slice(0, 100)}${input.length > 100 ? "…" : ""} → Result: ${resultText.slice(0, 100)}${resultText.length > 100 ? "…" : ""}${toolStr}`;

    // Dedup via embeddings — skip if too similar to recent auto-captures
    const summaryVec = await generateEmbedding(summary);
    if (summaryVec) {
      const tenantId = task.tenantId || null;
      const today = new Date().toISOString().split("T")[0];

      // Load recent auto-capture entries from daily_logs
      let recentRows;
      if (tenantId) {
        recentRows = queryAll(
          "SELECT entry FROM daily_logs WHERE tenant_id = $tid AND date = $date AND entry LIKE '%[auto]%' ORDER BY id DESC LIMIT 50",
          { $tid: tenantId, $date: today }
        );
      } else {
        recentRows = queryAll(
          "SELECT entry FROM daily_logs WHERE tenant_id IS NULL AND date = $date AND entry LIKE '%[auto]%' ORDER BY id DESC LIMIT 50",
          { $date: today }
        );
      }

      // Check cosine similarity against recent entries
      for (const row of recentRows) {
        const entryVec = await generateEmbedding(row.entry);
        if (entryVec && cosineSim(summaryVec, entryVec) > 0.95) {
          return; // Too similar — skip
        }
      }
    }

    // Write to daily log
    writeDailyLog({ entry: `[auto] ${summary}` });
    console.log(`[TaskRunner] Auto-captured task summary to daily log`);
  } catch {
    // Silent — auto-capture is best-effort
  }
}

/**
 * Post-task learning — trajectory extraction + background review.
 *
 * TrajectoryExtractor: structured learning extraction (our innovation)
 * BackgroundReviewer: agent-in-the-loop review for memory + skills (Hermes pattern)
 *
 * All non-blocking, fire-and-forget. Never crashes the main pipeline.
 */
async function _postTaskLearning(task, result, apiKeys) {
  try {
    const [
      { extractLearnings },
      { maybeRunReview },
    ] = await Promise.all([
      import("../learning/TrajectoryExtractor.js"),
      import("../learning/BackgroundReviewer.js"),
    ]);

    // Run both in parallel (independent, non-blocking)
    // - extractLearnings: structured tips for system prompt injection
    // - maybeRunReview: agent-in-the-loop review for memory + skills (Hermes pattern)
    await Promise.allSettled([
      extractLearnings(task, result, apiKeys),
      maybeRunReview(task, result, { apiKeys }),
    ]);
  } catch {
    // Silent — learning is best-effort
  }
}

/**
 * Task runner - worker loop that picks tasks from the queue and executes them.
 *
 * Configurable concurrency (default: 2 parallel tasks).
 */
class TaskRunner {
  constructor() {
    this.running = false;
    this.concurrency = 2;
    this.activeCount = 0;
    this.activeSessions = new Set();      // session IDs currently being processed
    this.sessionSteerQueues = new Map();  // sessionId → steerQueue[] for inject-on-concurrent
    this.pollInterval = null;
  }

  /**
   * Start the runner.
   */
  start() {
    if (this.running) return;
    this.running = true;

    // Poll for new tasks every 500ms
    this.pollInterval = setInterval(() => this.tick(), 500);
    console.log(`[TaskRunner] Started (concurrency: ${this.concurrency})`);
  }

  /**
   * Stop the runner.
   */
  stop() {
    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    console.log(`[TaskRunner] Stopped`);
  }

  /**
   * Poll tick - pick up work if available and under concurrency limit.
   */
  tick() {
    if (!this.running) return;
    if (!taskQueue.hasWork()) return;

    // ── Steer/inject: if next task belongs to an already-running session,
    //    append its message into the live agent loop rather than spawning a
    //    second loop.  The agent picks it up between tool calls (like Claude Code).
    // This runs regardless of concurrency - no extra slot needed.
    const nextTask = taskQueue.peek();
    if (nextTask?.sessionId && this.sessionSteerQueues.has(nextTask.sessionId)) {
      const steerTask = taskQueue.dequeue(); // consume from queue
      const steerQueue = this.sessionSteerQueues.get(steerTask.sessionId);
      steerQueue.push({ type: "user", content: steerTask.input }); // inject into live loop
      taskQueue.merge(steerTask.id);         // complete silently - no duplicate reply
      console.log(`[TaskRunner] Follow-up "${steerTask.input.slice(0, 60)}" injected into running session ${steerTask.sessionId}`);
      return;
    }

    // For starting a fresh agent loop, check concurrency + budget limits
    if (this.activeCount >= this.concurrency) return;

    if (isDailyBudgetExceeded()) {
      console.log(`[TaskRunner] Daily budget exceeded ($${config.maxDailyCost}). Pausing.`);
      return;
    }

    // Normal path: start a fresh agent loop for this task
    const task = taskQueue.dequeue(this.activeSessions);
    if (!task) return;

    // Set up steerQueue synchronously before processTask (no async gap → no race)
    const steerQueue = [];
    if (task.sessionId) {
      this.activeSessions.add(task.sessionId);
      this.sessionSteerQueues.set(task.sessionId, steerQueue);
    }

    this.activeCount++;
    this.processTask(task, steerQueue).finally(() => {
      this.activeCount--;
      if (task.sessionId) {
        this.activeSessions.delete(task.sessionId);
        this.sessionSteerQueues.delete(task.sessionId);
      }
    });
  }

  /**
   * Process a single task.
   * @param {object} task
   * @param {Array} steerQueue - Shared array; follow-up messages from the same session are
   *                             pushed here and picked up by AgentLoop between tool calls.
   */
  async processTask(task, steerQueue = []) {
    console.log(`\n[TaskRunner] Processing task ${task.id} from ${task.channel}`);

    // ── Prompt injection detection ─────────────────────────────────────────────
    // Check user input for jailbreak / credential-extraction attempts.
    // We don't block — we prepend a SECURITY_NOTICE so the agent is warned.
    // Channel-sourced tasks only (not http/a2a which have their own auth).
    if (task.input && task.channel && task.channel !== "http" && task.channel !== "a2a") {
      const injCheck = inputSanitizer.detectInjection(task.input);
      if (injCheck.suspicious) {
        task.input = injCheck.warningPrefix + task.input;
      }
    }
    // ──────────────────────────────────────────────────────────────────────────

    // ── Multi-tenant: resolve tenant and effective config ──────────────────────
    // Priority: explicit tenantId on task (cron/internal) > channelMeta.tenantId (per-tenant channel)
    //           > sessionId derivation (global channel, auto-create)
    let tenant = null;
    if (task.tenantId) {
      tenant = tenantManager.get(task.tenantId);
    } else if (task.channelMeta?.tenantId) {
      tenant = tenantManager.get(task.channelMeta.tenantId);
    } else if (task.channel && task.sessionId) {
      const userId = task.sessionId.slice(task.channel.length + 1);
      if (userId) {
        // For global channels: reuse existing global tenant if one exists
        // This links all global channel identities (telegram, discord, etc.) to one admin tenant
        const isGlobalChannel = !task.channelMeta?.tenantId;
        if (isGlobalChannel) {
          const existingGlobal = tenantManager.findGlobalTenant();
          if (existingGlobal) {
            tenant = existingGlobal;
          } else {
            tenant = tenantManager.getOrCreate(task.channel, userId);
            if (tenant) tenantManager.markAsGlobal(tenant.id);
          }
        } else {
          tenant = tenantManager.getOrCreate(task.channel, userId);
        }
      }
    }

    // ── Auto-link channel identity + routing metadata ───────────────────────
    // On every channel message (global or per-tenant), store the sender's
    // routing metadata (chatId, channelId, phone, sender, etc.) in tenant_channels.
    // This enables cross-channel sends and watcher delivery.
    // Works for all channel types — Telegram, Discord, Slack, WhatsApp, LINE, etc.
    // For global (no-tenant) setup: stores with tenant_id = "__global__"
    if (task.channel && task.channelMeta) {
      const linkTenantId = tenant?.id || "__global__";
      const cm = task.channelMeta;
      const senderId = cm.chatId || cm.userId || cm.phone || cm.sender || cm.chatGuid || cm.senderPubkey;
      if (senderId) {
        // Store only routing-relevant fields (strip internal/transient data)
        const routingMeta = {};
        for (const key of ["chatId", "userId", "channelId", "phone", "sender", "chatGuid",
                           "senderPubkey", "spaceName", "roomId", "target", "senderId",
                           "userName", "guildId", "threadTs", "replyToken"]) {
          if (cm[key] !== undefined) routingMeta[key] = cm[key];
        }
        try {
          if (tenant) {
            tenantManager.linkChannel(tenant.id, task.channel, senderId, routingMeta);
          }
          // Always cache routing meta for watcher delivery (works without tenants)
          const { run: dbRun } = await import("../storage/Database.js");
          const metaJson = JSON.stringify(routingMeta);
          dbRun(
            `INSERT OR REPLACE INTO channel_routing (channel, user_id, meta, updated_at)
             VALUES ($ch, $uid, $meta, datetime('now'))`,
            { $ch: task.channel, $uid: senderId, $meta: metaJson }
          );
        } catch {}
      }
    }

    // Block suspended tenants immediately
    if (tenant?.suspended) {
      const reason = tenant.suspendReason
        ? `Account suspended: ${tenant.suspendReason}`
        : "Account suspended. Contact the operator.";
      console.log(`[TaskRunner] Task ${task.id} rejected - tenant ${tenant.id} is suspended`);
      taskQueue.fail(task.id, reason);
      return;
    }

    // Resolve effective config: tenant config > channel config > global config
    const resolvedConfig = tenantManager.resolveTaskConfig(tenant, task.channelModel || null);

    // Per-tenant daily budget check (separate from global budget)
    if (tenant && resolvedConfig.maxDailyCost) {
      if (isTenantDailyBudgetExceeded(tenant.id, resolvedConfig.maxDailyCost)) {
        console.log(`[TaskRunner] Task ${task.id} rejected - tenant ${tenant.id} daily budget ($${resolvedConfig.maxDailyCost}) reached`);
        taskQueue.fail(task.id, `Daily budget of $${resolvedConfig.maxDailyCost} reached. Tasks resume tomorrow.`);
        return;
      }
    }

    // Main agent gets CORE_TOOLS only (24 tools, ~5K tokens).
    // Specialized tools available through profiles (sub-agents).
    // Tenant can further narrow with allowlist.
    const coreSet = new Set(CORE_TOOLS);
    let tools = resolvedConfig.tools?.length
      ? Object.fromEntries(Object.entries(toolFunctions).filter(([k]) => resolvedConfig.tools.includes(k) && coreSet.has(k)))
      : Object.fromEntries(Object.entries(toolFunctions).filter(([k]) => coreSet.has(k)));

    // Inject broadcast tool for cron tasks (delivery to presets)
    if (task.type === "cron" && toolFunctions.broadcast) {
      tools.broadcast = toolFunctions.broadcast;
    }

    // Remove blocked tools
    if (resolvedConfig.blockedTools?.length) {
      tools = Object.fromEntries(Object.entries(tools).filter(([k]) => !resolvedConfig.blockedTools.includes(k)));
    }

    // Filter MCP tools by per-tenant mcpServers allowlist (null = all allowed)
    const allowedMcpServers = resolvedConfig.mcpServers; // null = all
    if (allowedMcpServers !== null) {
      tools = Object.fromEntries(
        Object.entries(tools).filter(([name]) => {
          if (!name.startsWith("mcp__")) return true;
          const serverName = name.split("__")[1];
          return allowedMcpServers.includes(serverName);
        })
      );
    }

    // Resolved model for this task (used by sub-agents to inherit parent model)
    const resolvedModel = resolvedConfig.model || task.model || config.defaultModel || resolveDefaultModel(resolvedConfig.apiKeys);
    const apiKeys = resolvedConfig.apiKeys || {};

    try {
      // Wrap entire task execution in tenant context (AsyncLocalStorage).
      // This allows FilesystemGuard, memory tools, and other tools to read per-tenant config
      // without any race conditions across concurrent tasks.
      await tenantContext.run({ tenant, resolvedConfig, resolvedModel, apiKeys, sessionId: task.sessionId, channelMeta: task.channelMeta || null, directReplySent: false, currentTaskId: task.id, agentId: "main" }, async () => {
        // Get or create session
        let session = task.sessionId ? getSession(task.sessionId) : null;
        if (!session) {
          session = createSession(task.sessionId || null);
          task.sessionId = session.sessionId;
        }

        // Build system prompt (SOUL.md + MEMORY.md + semantic recall + daily log + matched skills)
        const systemPrompt = await buildSystemPrompt(task.input, "full", {
          model: resolvedModel,
          agentId: "main",
        });

        // Build message history — filter out raw tool-call/tool-result messages
        // that were persisted by onStepPersist and don't conform to ModelMessage[] schema
        const previousMessages = filterCleanMessages(
          session.messages.map((m) => ({ role: m.role, content: m.content }))
        );
        const messages = [...previousMessages, { role: "user", content: task.input }];

        // Track sub-agents spawned during this task
        const subAgents = [];
        const onSpawn = (evt) => {
          if (evt.parentTaskId === task.id) {
            subAgents.push({ agentId: evt.agentId, taskId: evt.taskId, description: evt.taskDescription, depth: evt.depth, status: "running", startedAt: new Date().toISOString() });
          }
        };
        const onFinish = (evt) => {
          if (evt.parentTaskId === task.id) {
            const sa = subAgents.find(s => s.agentId === evt.agentId);
            if (sa) {
              sa.status = evt.error ? "failed" : (evt.killed ? "killed" : "completed");
              sa.cost = evt.cost || null;
              sa.error = evt.error || null;
              sa.toolCalls = evt.toolCalls || [];
              sa.resultPreview = evt.resultPreview || null;
              sa.model = evt.model || null;
              sa.role = evt.role || null;
              sa.completedAt = new Date().toISOString();
            }
          }
        };
        eventBus.on("agent:spawned", onSpawn);
        eventBus.on("agent:finished", onFinish);

        // Persist the user message immediately before the loop starts
        appendMessage(session.sessionId, "user", task.input);


        // Run agent loop with resolved model, cost limits, and per-tenant API keys.
        // steerQueue lets follow-up messages from the same user be injected live
        // between tool calls instead of spawning a competing agent loop.
        const result = await runAgentLoop({
          messages,
          systemPrompt,
          tools,
          modelId: resolvedModel,
          taskId: task.id,
          approvalMode: task.approvalMode || "auto",
          channelMeta: task.channelMeta || null,
          maxCostPerTask: resolvedConfig.maxCostPerTask,
          apiKeys,
          steerQueue,
          onStepPersist: (stepMessages) => {
            for (const msg of stepMessages) {
              const compacted = compactForSession([msg])[0];
              appendMessage(session.sessionId, compacted.role, compacted.content);
            }
          },
        });

        // Clean up event listeners
        eventBus.removeListener("agent:spawned", onSpawn);
        eventBus.removeListener("agent:finished", onFinish);

        // Save final assistant text response (steps already persisted incrementally)
        if (result.text) {
          appendMessage(session.sessionId, "assistant", result.text);
        }

        // Update task cost info and tool calls
        task.cost = result.cost;
        task.toolCalls = result.toolCalls || [];
        if (subAgents.length > 0) task.subAgents = subAgents;

        // Record cost against tenant lifetime totals
        const estimatedCost = result.cost?.estimatedCost || 0;
        if (tenant) {
          tenantManager.recordCost(tenant.id, estimatedCost);
        }

        // If agent already replied directly (via sendFile), mark task so channel skips text reply
        const store = tenantContext.getStore();
        if (store?.directReplySent) {
          task.directReplySent = true;
        }

        // Forward result to extra destinations (watcher multi-delivery)
        if (task.extraDestinations?.length > 0 && result.text) {
          for (const dest of task.extraDestinations) {
            try {
              const channel = channelRegistry.get(dest.channel);
              if (channel?.running) {
                await channel.sendReply(dest.channelMeta, result.text);
              }
            } catch {}
          }
        }

        // Complete the task
        taskQueue.complete(task.id, result.text);
        const costStr = estimatedCost ? ` cost: $${estimatedCost.toFixed(4)}` : "";
        const tenantStr = tenant ? ` tenant: ${tenant.id}` : "";
        console.log(`[TaskRunner] Task ${task.id} completed (${costStr}${tenantStr})`);

        // Auto-capture to daily log (non-blocking, fire-and-forget)
        _autoCapture(task, result, resolvedConfig).catch(() => {});

        // Post-task learning (non-blocking, fire-and-forget)
        _postTaskLearning(task, result, apiKeys).catch(() => {});
      });
    } catch (error) {
      console.error(`[TaskRunner] Task ${task.id} failed:`, error.message);
      taskQueue.fail(task.id, error.message);
    }
  }
}

// Singleton
const taskRunner = new TaskRunner();
export default taskRunner;
