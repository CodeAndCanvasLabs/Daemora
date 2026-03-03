import { EventEmitter } from "events";

/**
 * Global event bus for inter-module communication.
 *
 * Events:
 *   task:created      - new task enqueued
 *   task:started      - task picked up by runner
 *   task:completed    - task finished successfully
 *   task:failed       - task failed
 *   tool:before       - about to execute a tool (PreToolUse hook point)
 *   tool:after        - tool execution finished (PostToolUse hook point)
 *   tool:blocked      - tool call was blocked by safety
 *   agent:spawned     - sub-agent created
 *   agent:finished    - sub-agent completed
 *   agent:killed      - sub-agent terminated by supervisor
 *   model:called      - LLM API call made (for cost tracking)
 *   compact:triggered - context compaction started
 *   memory:written    - memory entry added
 *   secret:detected   - secret found and redacted
 *   audit:event       - generic audit event
 */
class AgentEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /**
   * Emit and log an event for audit trail.
   */
  emitEvent(event, data = {}) {
    const payload = {
      event,
      timestamp: new Date().toISOString(),
      ...data,
    };
    this.emit(event, payload);
    this.emit("audit:event", payload);
    return payload;
  }
}

// Singleton
const eventBus = new AgentEventBus();
export default eventBus;
