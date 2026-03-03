import eventBus from "../core/EventBus.js";

/**
 * Circuit Breaker - prevents cascading failures in agent chains.
 *
 * Per-agent: 3 consecutive failures → stop the agent.
 * Per-tool: 5 failures in 1 minute → disable tool temporarily.
 * Reset after cooldown period.
 */

class CircuitBreaker {
  constructor() {
    // Track failures per tool
    this.toolFailures = new Map(); // toolName -> { count, lastFailure, disabled }
    // Track failures per task/agent
    this.agentFailures = new Map(); // taskId -> { consecutive, lastFailure }

    this.maxToolFailures = 5;
    this.toolCooldownMs = 60000; // 1 minute
    this.maxAgentFailures = 3;
  }

  /**
   * Record a tool failure.
   * @returns {{ tripped: boolean, reason?: string }}
   */
  recordToolFailure(toolName) {
    const now = Date.now();
    const entry = this.toolFailures.get(toolName) || {
      count: 0,
      firstFailure: now,
      disabled: false,
    };

    // Reset if cooldown has passed
    if (now - entry.firstFailure > this.toolCooldownMs) {
      entry.count = 0;
      entry.firstFailure = now;
      entry.disabled = false;
    }

    entry.count++;

    if (entry.count >= this.maxToolFailures) {
      entry.disabled = true;
      this.toolFailures.set(toolName, entry);
      eventBus.emitEvent("circuit:tool_disabled", {
        toolName,
        failures: entry.count,
      });
      return {
        tripped: true,
        reason: `Tool "${toolName}" disabled: ${entry.count} failures in ${this.toolCooldownMs / 1000}s. Will reset automatically.`,
      };
    }

    this.toolFailures.set(toolName, entry);
    return { tripped: false };
  }

  /**
   * Record an agent/task failure.
   * @returns {{ tripped: boolean, reason?: string }}
   */
  recordAgentFailure(taskId) {
    const entry = this.agentFailures.get(taskId) || { consecutive: 0 };
    entry.consecutive++;

    if (entry.consecutive >= this.maxAgentFailures) {
      this.agentFailures.set(taskId, entry);
      eventBus.emitEvent("circuit:agent_stopped", {
        taskId,
        failures: entry.consecutive,
      });
      return {
        tripped: true,
        reason: `Agent stopped: ${entry.consecutive} consecutive failures. Task may need human intervention.`,
      };
    }

    this.agentFailures.set(taskId, entry);
    return { tripped: false };
  }

  /**
   * Record success - resets consecutive failure counter.
   */
  recordSuccess(taskId) {
    if (taskId) {
      this.agentFailures.delete(taskId);
    }
  }

  /**
   * Check if a tool is currently disabled.
   */
  isToolDisabled(toolName) {
    const entry = this.toolFailures.get(toolName);
    if (!entry || !entry.disabled) return false;

    // Check if cooldown has passed
    if (Date.now() - entry.firstFailure > this.toolCooldownMs) {
      entry.disabled = false;
      entry.count = 0;
      this.toolFailures.set(toolName, entry);
      return false;
    }

    return true;
  }

  /**
   * Get stats.
   */
  stats() {
    return {
      disabledTools: [...this.toolFailures.entries()]
        .filter(([, e]) => e.disabled)
        .map(([name]) => name),
      activeBreakers: this.agentFailures.size,
    };
  }
}

const circuitBreaker = new CircuitBreaker();
export default circuitBreaker;
