import { runAgentLoop } from "./AgentLoop.js";
import { buildSystemPrompt } from "../systemPrompt.js";
import { toolFunctions } from "../tools/index.js";
import { createSession, getSession, setMessages } from "../services/sessions.js";
import taskQueue from "./TaskQueue.js";
import { isDailyBudgetExceeded, isTenantDailyBudgetExceeded } from "./CostTracker.js";
import { config } from "../config/default.js";
import tenantManager from "../tenants/TenantManager.js";
import tenantContext from "../tenants/TenantContext.js";
import inputSanitizer from "../safety/InputSanitizer.js";

/**
 * Filter out internal tool call/result JSON from messages before saving to session.
 * Keeps only clean user text and assistant text that users should see.
 */
function filterCleanMessages(messages) {
  return messages.filter(msg => {
    if (!msg.content || typeof msg.content !== "string") return false;

    const trimmed = msg.content.trimStart();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        // Assistant tool_call messages
        if (parsed.type === "tool_call" || parsed.tool_call) return false;
        // User tool_result messages
        if (parsed.tool_name) return false;
        // Structured finalResponse wrappers (the actual text is saved separately)
        if (parsed.type === "text" && parsed.finalResponse !== undefined) return false;
      } catch {
        // Not valid JSON - keep it (probably natural language that starts with {)
      }
    }

    // Filter out system injection messages
    if (msg.role === "user" && msg.content.startsWith("[Supervisor instruction]:")) return false;
    if (msg.role === "user" && msg.content.startsWith("[System:")) return false;
    if (msg.role === "user" && msg.content.includes("You have used") && msg.content.includes("iterations")) return false;
    if (msg.role === "user" && msg.content.includes("You are calling") && msg.content.includes("same params repeatedly")) return false;
    if (msg.role === "user" && msg.content.includes("Provide a text summary of what you did")) return false;

    return true;
  });
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
    // Derive userId from sessionId: sessionId = "${channel}-${userId}"
    let tenant = null;
    if (task.channel && task.sessionId) {
      const userId = task.sessionId.slice(task.channel.length + 1);
      if (userId) {
        tenant = tenantManager.getOrCreate(task.channel, userId);
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

    // Narrow tool list if tenant has a tool allowlist
    let tools = resolvedConfig.tools?.length
      ? Object.fromEntries(Object.entries(toolFunctions).filter(([k]) => resolvedConfig.tools.includes(k)))
      : { ...toolFunctions };

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
    const resolvedModel = resolvedConfig.model || task.model || config.defaultModel;
    const apiKeys = resolvedConfig.apiKeys || {};

    try {
      // Wrap entire task execution in tenant context (AsyncLocalStorage).
      // This allows FilesystemGuard, memory tools, and other tools to read per-tenant config
      // without any race conditions across concurrent tasks.
      await tenantContext.run({ tenant, resolvedConfig, resolvedModel, apiKeys, sessionId: task.sessionId }, async () => {
        // Get or create session
        let session = task.sessionId ? getSession(task.sessionId) : null;
        if (!session) {
          session = createSession(task.sessionId || null);
          task.sessionId = session.sessionId;
        }

        // Build system prompt (SOUL.md + MEMORY.md + semantic recall + daily log + matched skills)
        const systemPrompt = await buildSystemPrompt(task.input);

        // Build message history
        const previousMessages = session.messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));
        const messages = [...previousMessages, { role: "user", content: task.input }];

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
        });

        // Update session with CLEAN conversation only (strip internal tool JSON)
        setMessages(session.sessionId, filterCleanMessages(result.messages));

        // Update task cost info
        task.cost = result.cost;

        // Record cost against tenant lifetime totals
        const estimatedCost = result.cost?.estimatedCost || 0;
        if (tenant) {
          tenantManager.recordCost(tenant.id, estimatedCost);
        }

        // Complete the task
        taskQueue.complete(task.id, result.text);
        const costStr = estimatedCost ? ` cost: $${estimatedCost.toFixed(4)}` : "";
        const tenantStr = tenant ? ` tenant: ${tenant.id}` : "";
        console.log(`[TaskRunner] Task ${task.id} completed (${costStr}${tenantStr})`);
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
