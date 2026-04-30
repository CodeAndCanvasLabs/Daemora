/**
 * CircuitBreaker — stops cascading failures by tripping on repeated
 * tool or agent errors.
 *
 * Two independent tracks:
 *
 *   • **Per-tool:** N failures within a cooldown window disables the
 *     tool temporarily. Callers should consult `isToolDisabled(name)`
 *     before invoking and surface a helpful error if tripped.
 *
 *   • **Per-agent/task:** M consecutive failures trip the breaker.
 *     The TaskRunner / Supervisor can use this to pause the task and
 *     request human intervention instead of looping forever on the
 *     same broken call.
 *
 * Cooldown auto-resets once the window expires. Successful outcomes
 * clear the corresponding agent-failure counter (tools auto-clear on
 * cooldown only, so a string of flaky calls still trips).
 */

import { EventEmitter } from "node:events";

import { createLogger } from "../util/logger.js";

const log = createLogger("circuit-breaker");

export interface CircuitBreakerOpts {
  readonly maxToolFailures?: number;
  readonly toolCooldownMs?: number;
  readonly maxAgentFailures?: number;
}

interface ToolEntry {
  count: number;
  firstFailure: number;
  disabled: boolean;
}

interface AgentEntry {
  consecutive: number;
}

export interface BreakerResult {
  readonly tripped: boolean;
  readonly reason?: string;
}

export class CircuitBreaker extends EventEmitter {
  private readonly toolFailures = new Map<string, ToolEntry>();
  private readonly agentFailures = new Map<string, AgentEntry>();

  private readonly maxToolFailures: number;
  private readonly toolCooldownMs: number;
  private readonly maxAgentFailures: number;

  constructor(opts: CircuitBreakerOpts = {}) {
    super();
    this.maxToolFailures = opts.maxToolFailures ?? 5;
    this.toolCooldownMs = opts.toolCooldownMs ?? 60_000;
    this.maxAgentFailures = opts.maxAgentFailures ?? 3;
  }

  /** Record a tool failure. Returns `tripped: true` when the tool has been disabled. */
  recordToolFailure(toolName: string): BreakerResult {
    const now = Date.now();
    const entry = this.toolFailures.get(toolName) ?? {
      count: 0,
      firstFailure: now,
      disabled: false,
    };
    // Reset the window if cooldown has elapsed.
    if (now - entry.firstFailure > this.toolCooldownMs) {
      entry.count = 0;
      entry.firstFailure = now;
      entry.disabled = false;
    }
    entry.count++;

    if (entry.count >= this.maxToolFailures) {
      entry.disabled = true;
      this.toolFailures.set(toolName, entry);
      log.warn({ tool: toolName, failures: entry.count }, "tool circuit tripped");
      this.emit("tool:disabled", { toolName, failures: entry.count });
      return {
        tripped: true,
        reason:
          `Tool '${toolName}' disabled: ${entry.count} failures in ${Math.round(this.toolCooldownMs / 1000)}s. ` +
          `Will reset automatically.`,
      };
    }

    this.toolFailures.set(toolName, entry);
    return { tripped: false };
  }

  /** Record a whole-task failure. Returns `tripped: true` at the limit. */
  recordAgentFailure(taskId: string): BreakerResult {
    const entry = this.agentFailures.get(taskId) ?? { consecutive: 0 };
    entry.consecutive++;

    if (entry.consecutive >= this.maxAgentFailures) {
      this.agentFailures.set(taskId, entry);
      log.warn({ taskId, failures: entry.consecutive }, "agent circuit tripped");
      this.emit("agent:stopped", { taskId, failures: entry.consecutive });
      return {
        tripped: true,
        reason: `Task stopped after ${entry.consecutive} consecutive failures — human intervention needed.`,
      };
    }
    this.agentFailures.set(taskId, entry);
    return { tripped: false };
  }

  /** A loop detection counts as a double tool failure. */
  recordLoopDetection(toolName: string): BreakerResult {
    this.recordToolFailure(toolName);
    return this.recordToolFailure(toolName);
  }

  /** Called after a successful call — clears the agent's counter. */
  recordSuccess(taskId: string): void {
    this.agentFailures.delete(taskId);
  }

  /** Is this tool currently in the tripped/disabled state? */
  isToolDisabled(toolName: string): boolean {
    const entry = this.toolFailures.get(toolName);
    if (!entry?.disabled) return false;
    if (Date.now() - entry.firstFailure > this.toolCooldownMs) {
      entry.disabled = false;
      entry.count = 0;
      this.toolFailures.set(toolName, entry);
      return false;
    }
    return true;
  }

  stats(): { disabledTools: string[]; activeBreakers: number } {
    return {
      disabledTools: [...this.toolFailures.entries()]
        .filter(([, e]) => e.disabled)
        .map(([name]) => name),
      activeBreakers: this.agentFailures.size,
    };
  }
}

export const circuitBreaker = new CircuitBreaker();
