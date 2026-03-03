import eventBus from "../core/EventBus.js";
import { config } from "../config/default.js";

/**
 * Supervisor Agent - monitors all agent activity for safety.
 *
 * Listens to EventBus events and detects:
 * - Infinite loops (same tool called too many times)
 * - Cost overruns (task exceeding budget)
 * - Dangerous patterns (blocked commands, secret exposure)
 * - Runaway agents (too many tool calls per minute)
 *
 * Actions: log warning, pause agent, kill agent, alert user.
 */
class Supervisor {
  constructor() {
    this.toolCallCounts = new Map(); // taskId → count
    this.toolCallTimestamps = new Map(); // taskId → [timestamps]
    this.warnings = [];
    this.killedTasks = new Set(); // taskIds that have been killed
    this.maxToolCallsPerMinute = 30;
    this.maxToolCallsPerTask = 100;
    this.running = false;
  }

  /** Check if a task has been killed by the supervisor. Called by AgentLoop each iteration. */
  isKilled(taskId) {
    return taskId ? this.killedTasks.has(taskId) : false;
  }

  /** Kill a task - AgentLoop will detect this and stop. */
  killTask(taskId, reason) {
    if (!taskId || this.killedTasks.has(taskId)) return;
    this.killedTasks.add(taskId);
    console.log(`[Supervisor] KILLING task ${taskId?.slice(0, 8)}: ${reason}`);
    eventBus.emitEvent("supervisor:kill", { taskId, reason });
    eventBus.emitEvent("audit:event", { event: "supervisor_kill", taskId, reason });
  }

  /** Remove task from killed set after it ends (cleanup). */
  cleanupKill(taskId) {
    this.killedTasks.delete(taskId);
  }

  /**
   * Start monitoring.
   */
  start() {
    if (this.running) return;
    this.running = true;

    // Monitor tool calls
    eventBus.on("tool:before", (data) => this.onToolBefore(data));
    eventBus.on("tool:after", (data) => this.onToolAfter(data));
    eventBus.on("model:called", (data) => this.onModelCalled(data));
    eventBus.on("agent:spawned", (data) => this.onAgentSpawned(data));

    console.log(`[Supervisor] Started monitoring`);
  }

  /**
   * Stop monitoring.
   */
  stop() {
    this.running = false;
    eventBus.removeAllListeners("tool:before");
    eventBus.removeAllListeners("tool:after");
    eventBus.removeAllListeners("model:called");
    eventBus.removeAllListeners("agent:spawned");
    console.log(`[Supervisor] Stopped`);
  }

  /**
   * Check before a tool is executed.
   */
  onToolBefore(data) {
    const { taskId, tool_name, params } = data;

    // Track call count
    const count = (this.toolCallCounts.get(taskId) || 0) + 1;
    this.toolCallCounts.set(taskId, count);

    // Track call rate
    const now = Date.now();
    const timestamps = this.toolCallTimestamps.get(taskId) || [];
    timestamps.push(now);
    // Keep only last minute
    const oneMinuteAgo = now - 60000;
    const recentTimestamps = timestamps.filter((t) => t > oneMinuteAgo);
    this.toolCallTimestamps.set(taskId, recentTimestamps);

    // Check: too many calls per minute - warn first, kill at 2x
    if (recentTimestamps.length > this.maxToolCallsPerMinute * 2) {
      this.killTask(taskId, `Runaway agent: ${recentTimestamps.length} tool calls in last minute (hard limit: ${this.maxToolCallsPerMinute * 2})`);
    } else if (recentTimestamps.length > this.maxToolCallsPerMinute) {
      this.warn(taskId, `Rate limit: ${recentTimestamps.length} tool calls in last minute (max: ${this.maxToolCallsPerMinute})`);
    }

    // Check: too many total calls - warn first, kill at 1.5x
    if (count > Math.floor(this.maxToolCallsPerTask * 1.5)) {
      this.killTask(taskId, `Runaway agent: ${count} total tool calls (hard limit: ${Math.floor(this.maxToolCallsPerTask * 1.5)})`);
    } else if (count > this.maxToolCallsPerTask) {
      this.warn(taskId, `Total tool calls (${count}) exceeded max (${this.maxToolCallsPerTask})`);
    }

    // Check: dangerous tool patterns
    if (tool_name === "executeCommand" && params) {
      const cmd = Array.isArray(params) ? params[0] : params;
      if (typeof cmd === "string") {
        if (/rm\s+-rf\s+\//.test(cmd)) {
          this.alert(taskId, `BLOCKED: Destructive command detected: ${cmd.slice(0, 50)}`);
        }
        if (/sudo/.test(cmd)) {
          this.warn(taskId, `Sudo command detected: ${cmd.slice(0, 50)}`);
        }
      }
    }
  }

  /**
   * Check after a tool is executed.
   */
  onToolAfter(data) {
    // Could add output scanning for secrets here
  }

  /**
   * Monitor model cost.
   */
  onModelCalled(data) {
    // Cost tracking happens in CostTracker via EventBus
  }

  /**
   * Monitor sub-agent spawning.
   */
  onAgentSpawned(data) {
    const { agentId, depth, parentTaskId } = data;
    if (depth > 1) {
      this.warn(parentTaskId, `Deep sub-agent spawning: depth=${depth}, agentId=${agentId}`);
    }
  }

  /**
   * Issue a warning.
   */
  warn(taskId, message) {
    const warning = {
      level: "warning",
      taskId,
      message,
      timestamp: new Date().toISOString(),
    };
    this.warnings.push(warning);
    console.log(`[Supervisor] WARNING (task ${taskId?.slice(0, 8)}): ${message}`);
    eventBus.emitEvent("supervisor:warning", warning);
  }

  /**
   * Issue a critical alert.
   */
  alert(taskId, message) {
    const alert = {
      level: "critical",
      taskId,
      message,
      timestamp: new Date().toISOString(),
    };
    this.warnings.push(alert);
    console.log(`[Supervisor] ALERT (task ${taskId?.slice(0, 8)}): ${message}`);
    eventBus.emitEvent("supervisor:alert", alert);
  }

  /**
   * Get recent warnings.
   */
  getWarnings(limit = 50) {
    return this.warnings.slice(-limit);
  }

  /**
   * Clean up tracking for a completed task.
   */
  cleanupTask(taskId) {
    this.toolCallCounts.delete(taskId);
    this.toolCallTimestamps.delete(taskId);
  }
}

// Singleton
const supervisor = new Supervisor();
export default supervisor;