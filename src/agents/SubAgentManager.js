import { runAgentLoop } from "../core/AgentLoop.js";
import { buildSystemPrompt } from "../systemPrompt.js";
import { toolFunctions } from "../tools/index.js";
import { agentProfiles, defaultSubAgentTools } from "../config/agentProfiles.js";
import { config } from "../config/default.js";
import eventBus from "../core/EventBus.js";
import { v4 as uuidv4 } from "uuid";
import tenantContext from "../tenants/TenantContext.js";
import { resolveModelForProfile } from "../models/ModelRouter.js";
import { createSession, getSession, setMessages } from "../services/sessions.js";

/**
 * Sub-Agent Manager - spawns, tracks, kills, and steers sub-agents.
 *
 * Each sub-agent entry stores:
 *   - taskDescription, startedAt, parentTaskId
 *   - abortController  → hard-kills the agent (aborts mid-API-call too)
 *   - steerQueue       → shared array; push here to inject a steering message
 *                        into the running agent's next loop iteration
 *
 * Kill propagation:
 *   When the Supervisor kills a parent task, it emits "supervisor:kill".
 *   We listen to that event and abort all child agents of the killed task.
 *
 * Context sharing:
 *   Pass parentContext (string) to give the sub-agent summary info from
 *   the parent before it starts.
 */

const MAX_CONCURRENT_SUB_AGENTS = 7;

/** Map<agentId, { taskDescription, startedAt, parentTaskId, abortController, steerQueue }> */
const activeSubAgents = new Map();

// ── Demo-friendly colored logging ─────────────────────────────────────────────
const C = {
  cyan:    "\x1b[36m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  red:     "\x1b[31m",
  magenta: "\x1b[35m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  reset:   "\x1b[0m",
};

function _agentLog(color, icon, agentId, depth, message) {
  const indent = "  ".repeat(depth);
  const tag    = `${C.dim}[${agentId}]${C.reset}`;
  const active = activeSubAgents.size > 0 ? `${C.dim} (${activeSubAgents.size} active)${C.reset}` : "";
  console.log(`${indent}${color}${icon} ${tag} ${message}${C.reset}${active}`);
}

// ── Kill propagation: when Supervisor kills a parent, kill all its children ──
eventBus.on("supervisor:kill", ({ taskId }) => {
  for (const [agentId, info] of activeSubAgents.entries()) {
    const isChild = info.parentTaskId === taskId;
    const isSelf  = `subagent-${agentId}` === taskId;
    if (isChild || isSelf) {
      console.log(`[SubAgentManager] Killing sub-agent ${agentId} (parent ${taskId} killed)`);
      info.abortController.abort();
      activeSubAgents.delete(agentId);
      eventBus.emitEvent("agent:killed", { agentId, reason: `parent task killed (${taskId})` });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spawn a sub-agent to handle a specific task.
 *
 * @param {string} taskDescription  What the sub-agent should do
 * @param {object} options
 * @param {string}   [options.model]               Model override
 * @param {string}   [options.profile]             Role preset: "researcher"|"coder"|"writer"|"analyst"
 * @param {string[]} [options.extraTools]          Additional tools on top of profile or default
 * @param {string[]} [options.tools]               Explicit tool list (overrides profile)
 * @param {object}   [options.toolOverride]        Exact tool functions (specialist agents, bypasses all)
 * @param {object}   [options.systemPromptOverride] Replace system prompt entirely (specialist agents)
 * @param {number}   [options.maxCost]             Cost budget
 * @param {number}   [options.timeout]             Timeout in ms
 * @param {number}   [options.depth]               Recursion depth (managed internally)
 * @param {string}   [options.parentTaskId]        Parent task ID for kill propagation
 * @param {string}   [options.parentContext]       Summary/context from parent agent
 * @param {string}   [options.approvalMode]        Inherited approval mode
 * @param {object}   [options.channelMeta]         Inherited channel meta for approvals
 * @returns {Promise<string>} Sub-agent's final response
 */
export async function spawnSubAgent(taskDescription, options = {}) {
  const {
    model                = null,
    profile              = null,        // role preset: researcher | coder | writer | analyst
    extraTools           = null,        // additional tools on top of profile or default
    tools: allowedTools  = null,        // explicit list - overrides profile
    toolOverride         = null,        // exact tool functions - specialist agents only (e.g. MCP)
    systemPromptOverride = null,        // replace system prompt - specialist agents only
    maxCost              = 0.10,
    timeout              = 300_000,
    depth                = 0,
    parentTaskId         = null,
    parentContext        = null,
    approvalMode         = "auto",
    channelMeta          = null,
    historyMessages      = [],     // previous session messages to prepend (persistent sub-agent sessions)
    returnFullResult     = false,  // return {text, messages, cost} instead of just text
  } = options;

  const maxDepth = 3;
  if (depth >= maxDepth) {
    return `Cannot spawn sub-agent: maximum depth (${maxDepth}) reached. Complete this task directly.`;
  }

  if (activeSubAgents.size >= MAX_CONCURRENT_SUB_AGENTS) {
    return `Cannot spawn sub-agent: maximum concurrent agents (${MAX_CONCURRENT_SUB_AGENTS}) reached. Wait for others to finish.`;
  }

  const agentId = uuidv4().slice(0, 8);
  const taskId  = `subagent-${agentId}`;

  // ── Model resolution - priority: explicit > profile routing > parent > global default ───────
  const store = tenantContext.getStore();
  const resolvedModel = model
    || resolveModelForProfile(profile, store?.resolvedConfig || {}, null)
    || store?.resolvedModel
    || config.defaultModel;

  const profileLabel = profile ? ` [${profile}]` : "";
  const modelLabel   = resolvedModel ? ` ${C.dim}(${resolvedModel})${C.reset}` : "";
  _agentLog(C.cyan + C.bold, "🤖 SPAWN", agentId, depth,
    `${C.cyan}${C.bold}${profileLabel}${C.reset}${modelLabel} "${taskDescription.slice(0, 80)}${taskDescription.length > 80 ? "…" : ""}"`);


  const apiKeys = store?.apiKeys || {};

  // ── Tool set ──────────────────────────────────────────────────────────────
  // Resolution order (highest priority first):
  //   1. toolOverride  - exact functions, specialist agents only (e.g. MCP agents)
  //   2. allowedTools  - explicit name list from caller
  //   3. profile       - role preset ("researcher", "coder", etc.) + optional extraTools
  //   4. default       - defaultSubAgentTools (27 tools, excludes blast-radius tools)
  let agentTools;
  if (toolOverride) {
    // Specialist agents (MCP, etc.) - bypass all filtering entirely
    agentTools = { ...toolOverride };
  } else {
    let toolNames;

    if (allowedTools) {
      // Caller provided explicit list - use as-is
      toolNames = [...allowedTools];
    } else if (profile) {
      // Named role preset
      const preset = agentProfiles[profile];
      if (!preset) {
        console.warn(`[SubAgent:${agentId}] Unknown profile "${profile}", using default`);
        toolNames = [...defaultSubAgentTools];
      } else {
        toolNames = [...preset];
      }
    } else {
      // No profile specified - use sensible default (not all 33 tools)
      toolNames = [...defaultSubAgentTools];
    }

    // Apply extraTools on top of whatever was resolved above
    if (extraTools) {
      for (const t of extraTools) {
        if (!toolNames.includes(t)) toolNames.push(t);
      }
    }

    agentTools = {};
    for (const name of toolNames) {
      if (toolFunctions[name]) agentTools[name] = toolFunctions[name];
    }

    // Inject depth-aware spawnAgent and parallelAgents at next depth level.
    // These are NOT in any profile - they're always injected dynamically so
    // depth propagation is always correct regardless of profile used.
    if (depth + 1 < maxDepth) {
      agentTools.spawnAgent = (desc, opts) => {
        const parsedOpts = typeof opts === "string" ? JSON.parse(opts) : (opts || {});
        return spawnSubAgent(desc, {
          ...parsedOpts,
          depth: depth + 1,
          parentTaskId: taskId,
          channelMeta,
          approvalMode,
          model: parsedOpts.model || resolvedModel,  // inherit parent model if not explicitly set
        });
      };

      // Wrap parallelAgents to correctly propagate depth.
      // Without this, parallel agents spawned by sub-agents would get depth=0
      // (the default), allowing infinite nesting and defeating the depth limit.
      agentTools.parallelAgents = (tasksJson, sharedOptionsJson) => {
        const tasks = typeof tasksJson === "string" ? JSON.parse(tasksJson) : (tasksJson || []);
        const sharedOpts = typeof sharedOptionsJson === "string"
          ? JSON.parse(sharedOptionsJson)
          : (sharedOptionsJson || {});
        const tasksWithDepth = tasks.map((t) => ({
          ...t,
          options: {
            ...(t.options || {}),
            depth:       depth + 1,
            parentTaskId: t.options?.parentTaskId || taskId,
            channelMeta:  t.options?.channelMeta  || channelMeta,
            approvalMode: t.options?.approvalMode  || approvalMode,
          },
        }));
        return spawnParallelAgents(tasksWithDepth, sharedOpts);
      };
    }
  }

  // ── Coordination primitives ───────────────────────────────────────────────
  const abortController = new AbortController();
  const steerQueue      = [];   // Shared mutable array - push here to steer the agent

  activeSubAgents.set(agentId, {
    taskDescription,
    startedAt: Date.now(),
    parentTaskId,
    abortController,
    steerQueue,
  });

  eventBus.emitEvent("agent:spawned", {
    agentId,
    taskId,
    parentTaskId,
    depth,
    taskDescription: taskDescription.slice(0, 100),
  });

  // ── Auto session load for regular sub-agents (not MCP — they manage their own) ──
  const mainSessionId = store?.sessionId || null;
  const shouldManageSession = !toolOverride && historyMessages.length === 0 && mainSessionId;
  let subSessionId = null;

  if (shouldManageSession) {
    const sessionKey = profile || "general";
    subSessionId = `${mainSessionId}--${sessionKey}`;
    const subSession = getSession(subSessionId);
    if (subSession && subSession.messages.length > 0) {
      historyMessages = subSession.messages.map(m => ({ role: m.role, content: m.content }));
      console.log(`[SubAgent:${agentId}] Loaded ${historyMessages.length} history messages from "${subSessionId}"`);
    }
  }

  // ── Build initial messages (include history + optionally parent context) ──
  const initialMessages = [...historyMessages];

  if (parentContext) {
    initialMessages.push({
      role: "user",
      content: `[Context from parent agent]:\n${parentContext}\n\n[Your task]:\n${taskDescription}`,
    });
  } else {
    initialMessages.push({ role: "user", content: taskDescription });
  }

  // ── Run with timeout and abort signal ─────────────────────────────────────
  const startedAt = activeSubAgents.get(agentId).startedAt;

  try {
    const result = await Promise.race([
      runAgentLoop({
        messages:     initialMessages,
        systemPrompt: systemPromptOverride || await buildSystemPrompt(taskDescription),
        tools:        agentTools,
        modelId:      resolvedModel,
        taskId,
        approvalMode,
        channelMeta,
        signal:       abortController.signal,   // hard kill support
        steerQueue,                              // steering support
        apiKeys,                                 // per-tenant API key overlay
      }),
      new Promise((_, reject) =>
        setTimeout(() => {
          abortController.abort();
          reject(new Error(`Sub-agent timed out after ${timeout / 1000}s`));
        }, timeout)
      ),
    ]);

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const costVal = typeof result.cost === "number" ? result.cost : result.cost?.estimatedCost;
    const costStr = costVal ? ` $${costVal.toFixed(4)}` : "";
    _agentLog(C.green + C.bold, "✅ DONE ", agentId, depth,
      `${C.green}${C.bold}completed in ${elapsed}s${costStr}${C.reset}`);
    eventBus.emitEvent("agent:finished", {
      agentId, taskId, parentTaskId, cost: result.cost,
      toolCalls: (result.toolCalls || []).map(tc => ({ tool: tc.tool, duration: tc.duration })),
      resultPreview: (result.text || "").slice(0, 200),
      model: resolvedModel,
      role: profile || "general",
    });

    // ── Auto session save for regular sub-agents ──────────────────────────
    if (subSessionId && result.messages) {
      let subSession = getSession(subSessionId);
      if (!subSession) subSession = createSession(subSessionId);
      const capped = result.messages.length > 100
        ? result.messages.slice(-100)
        : result.messages;
      setMessages(subSessionId, capped);
      console.log(`[SubAgent:${agentId}] Saved ${capped.length} messages to "${subSessionId}"`);
    }

    if (returnFullResult) {
      return { text: result.text, messages: result.messages, cost: result.cost };
    }
    return result.text;

  } catch (error) {
    const killed = abortController.signal.aborted;
    _agentLog(killed ? C.yellow : C.red, killed ? "⛔ KILL " : "❌ FAIL ", agentId, depth,
      `${error.message}`);
    eventBus.emitEvent("agent:finished", { agentId, taskId, parentTaskId, error: error.message, killed });
    return killed
      ? `Sub-agent was stopped by the supervisor.`
      : `Sub-agent error: ${error.message}`;
  } finally {
    activeSubAgents.delete(agentId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spawn multiple sub-agents in parallel and collect results.
 *
 * @param {Array<{description, options}>} tasks
 * @param {object} sharedOptions
 * @param {string}  [sharedOptions.sharedContext]  Spec/contract passed to ALL agents as parentContext.
 *                                                  Use this to share HTML structure with CSS/JS agents,
 *                                                  API schema with frontend/backend agents, etc.
 * @param {string}  [sharedOptions.parentTaskId]   For kill propagation
 * @param {string}  [sharedOptions.approvalMode]
 * @param {object}  [sharedOptions.channelMeta]
 */
export async function spawnParallelAgents(tasks, sharedOptions = {}) {
  const { sharedContext = null, parentTaskId = null, approvalMode = "auto", channelMeta = null } = sharedOptions;

  const parallelStart = Date.now();
  console.log(`\n${C.magenta}${C.bold}🚀 PARALLEL - launching ${tasks.length} agents simultaneously${C.reset}`);
  tasks.forEach((t, i) => {
    const profile = t.options?.profile ? ` [${t.options.profile}]` : "";
    console.log(`${C.magenta}   ${i + 1}/${tasks.length}${profile} - "${(t.description || "").slice(0, 70)}${(t.description || "").length > 70 ? "…" : ""}"${C.reset}`);
  });
  console.log();

  const results = await Promise.allSettled(
    tasks.map((t) => {
      const opts = t.options || {};
      // Merge sharedContext: if task already has parentContext, prepend the shared spec
      const mergedContext = sharedContext
        ? (opts.parentContext
            ? `[Shared spec for all agents]:\n${sharedContext}\n\n[Additional context]:\n${opts.parentContext}`
            : sharedContext)
        : opts.parentContext || null;

      return spawnSubAgent(t.description, {
        ...opts,
        parentContext: mergedContext,
        parentTaskId:  opts.parentTaskId || parentTaskId,
        approvalMode:  opts.approvalMode  || approvalMode,
        channelMeta:   opts.channelMeta   || channelMeta,
      });
    })
  );

  const elapsed   = ((Date.now() - parallelStart) / 1000).toFixed(1);
  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed    = results.length - succeeded;
  const summary   = failed === 0
    ? `${C.green}${C.bold}all ${succeeded} completed${C.reset}`
    : `${C.green}${succeeded} ok${C.reset} / ${C.red}${failed} failed${C.reset}`;
  console.log(`\n${C.magenta}${C.bold}🏁 PARALLEL DONE - ${summary}${C.magenta}${C.bold} in ${elapsed}s total${C.reset}\n`);

  return results.map((r, i) => ({
    task:   tasks[i].description.slice(0, 80),
    status: r.status,
    result: r.status === "fulfilled" ? r.value : (r.reason?.message || "Failed"),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Management API
// ─────────────────────────────────────────────────────────────────────────────

export function getActiveSubAgentCount() {
  return activeSubAgents.size;
}

export function listActiveAgents() {
  return [...activeSubAgents.entries()].map(([id, info]) => ({
    id,
    taskId:      `subagent-${id}`,
    parentTaskId: info.parentTaskId,
    task:         info.taskDescription.slice(0, 120),
    startedAt:    new Date(info.startedAt).toISOString(),
    elapsedMs:    Date.now() - info.startedAt,
    steerable:    true,
  }));
}

/**
 * Hard-kill a sub-agent by agent ID - with cascade kill to all descendants.
 * Aborts mid-API-call via AbortController - breaks out immediately.
 * Recursively kills all child and grandchild agents before killing the target.
 */
export function killAgent(agentId) {
  const agent = activeSubAgents.get(agentId);
  if (!agent) {
    return `No active agent found: ${agentId}. Use manageAgents("list") to see active agents.`;
  }

  // Cascade: kill all direct children first (recursive, so grandchildren are handled too)
  const taskId = `subagent-${agentId}`;
  const childIds = [...activeSubAgents.entries()]
    .filter(([, info]) => info.parentTaskId === taskId)
    .map(([id]) => id);

  for (const childId of childIds) {
    killAgent(childId); // recursive cascade
  }

  // Now kill this agent
  agent.abortController.abort();
  activeSubAgents.delete(agentId);
  eventBus.emitEvent("agent:killed", { agentId, reason: "manual kill (cascade)" });
  console.log(`[SubAgentManager] Hard-killed agent ${agentId}${childIds.length ? ` + ${childIds.length} child(ren)` : ""}`);
  return `Agent ${agentId} killed${childIds.length ? ` (cascade: ${childIds.length} child agent(s) also stopped)` : ""}.`;
}

/**
 * Inject a steering instruction into a running sub-agent.
 * Picked up at the next loop iteration in AgentLoop (drains steerQueue).
 */
export function steerAgent(agentId, message) {
  const agent = activeSubAgents.get(agentId);
  if (!agent) {
    return `No active agent found: ${agentId}.`;
  }
  agent.steerQueue.push(message);
  console.log(`[SubAgentManager] Steered agent ${agentId}: "${message.slice(0, 60)}"`);
  return `Steering message sent to agent ${agentId}. It will be injected on the next loop iteration.`;
}
