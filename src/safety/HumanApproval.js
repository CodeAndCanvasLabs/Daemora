import eventBus from "../core/EventBus.js";

/**
 * Human Approval - pause agent and ask user before dangerous tool calls.
 *
 * Approval modes:
 *   "auto"           - fully autonomous, no pauses
 *   "dangerous-only" - pause before destructive tools (default for most tasks)
 *   "every-tool"     - approve every single tool call
 *
 * Flow:
 *   1. AgentLoop calls requestApproval(taskId, tool_name, params, channelMeta, mode)
 *   2. HumanApproval emits "approval:request" event (channels pick this up)
 *   3. Channel sends user a message: "Agent wants to run X. Reply approve/deny + requestId"
 *   4. User replies → channel calls humanApproval.handleReply(text)
 *   5. Promise resolves with true/false → AgentLoop proceeds or skips the tool
 *
 * Timeout: if user doesn't reply within timeoutMs, falls back to onTimeout ("deny" by default).
 */

// Tools that require approval in "dangerous-only" mode.
// Only external/irreversible operations that affect people outside the agent:
// - Communications (email, messages) - can't unsend
// - Scheduling (cron) - creates recurring side effects
// File writes, commands, browser, etc. are fully autonomous.
const DANGEROUS_TOOLS = new Set([
  "sendEmail",
  "messageChannel",
  "cron",
]);

class HumanApproval {
  constructor() {
    /** Map of requestId → { resolve, timer, taskId, tool_name, params } */
    this.pending = new Map();
    this.timeoutMs = 120_000; // 2 minutes
    this.onTimeout = "deny";  // "deny" | "allow"
  }

  /**
   * Check whether a tool call needs approval given the current mode.
   */
  needsApproval(tool_name, mode) {
    if (!mode || mode === "auto") return false;
    if (mode === "every-tool") return true;
    if (mode === "dangerous-only") return DANGEROUS_TOOLS.has(tool_name);
    return false;
  }

  /**
   * Request approval from the user for a tool call.
   * Returns a Promise<boolean> - true = approved, false = denied.
   */
  async requestApproval(taskId, tool_name, params, channelMeta) {
    const requestId = `apr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const paramPreview = typeof params === "object" ? JSON.stringify(params).slice(0, 160) : String(params).slice(0, 160);

    console.log(`[HumanApproval] Waiting for approval: ${requestId} - ${tool_name}(${paramPreview})`);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        const decision = this.onTimeout === "allow";
        console.log(`[HumanApproval] Request ${requestId} timed out → ${decision ? "allowed" : "denied"}`);
        eventBus.emitEvent("audit:approval_result", { requestId, tool_name, taskId, approved: decision, source: "timeout" });
        resolve(decision);
      }, this.timeoutMs);

      this.pending.set(requestId, { resolve, timer, taskId, tool_name, params });

      // Emit event - channels (Telegram, HTTP) pick this up and message the user
      eventBus.emitEvent("approval:request", {
        requestId,
        taskId,
        tool_name,
        params,
        channelMeta,
        timeoutMs: this.timeoutMs,
        message: this._buildMessage(requestId, tool_name, paramPreview),
      });

      eventBus.emitEvent("audit:approval_requested", { requestId, tool_name, taskId, channelMeta });
    });
  }

  /**
   * Approve a pending request.
   * Returns true if the requestId was found and resolved.
   */
  approve(requestId, source = "user") {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    console.log(`[HumanApproval] APPROVED: ${requestId} by ${source}`);
    eventBus.emitEvent("audit:approval_result", { requestId, tool_name: pending.tool_name, taskId: pending.taskId, approved: true, source });
    pending.resolve(true);
    return true;
  }

  /**
   * Deny a pending request.
   */
  deny(requestId, source = "user") {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    console.log(`[HumanApproval] DENIED: ${requestId} by ${source}`);
    eventBus.emitEvent("audit:approval_result", { requestId, tool_name: pending.tool_name, taskId: pending.taskId, approved: false, source });
    pending.resolve(false);
    return true;
  }

  /**
   * Parse a free-form user reply for approval/denial.
   * Returns true if a pending request was found and handled.
   */
  handleReply(text) {
    const match = text.match(/apr-[a-z0-9]+-[a-z0-9]+/i);
    if (!match) return false;
    const requestId = match[0];
    if (!this.pending.has(requestId)) return false;
    const approved = /\b(yes|approve|allow|ok|okay|go|run|do it|confirm|✓|👍)\b/i.test(text);
    return approved ? this.approve(requestId) : this.deny(requestId);
  }

  /** List all pending approvals. */
  pendingList() {
    return [...this.pending.entries()].map(([id, p]) => ({
      requestId: id,
      taskId: p.taskId,
      tool_name: p.tool_name,
    }));
  }

  _buildMessage(requestId, tool_name, paramPreview) {
    const lines = [
      `⚠️ Agent wants to run a tool that requires your approval:`,
      ``,
      `  Tool: ${tool_name}`,
      paramPreview ? `  Args: ${paramPreview}` : null,
      ``,
      `Reply with:`,
      `  ✅ approve ${requestId}`,
      `  ❌ deny ${requestId}`,
      ``,
      `(Auto-${this.onTimeout}s in ${Math.round(this.timeoutMs / 1000)}s if no reply)`,
    ].filter((l) => l !== null);
    return lines.join("\n");
  }
}

const humanApproval = new HumanApproval();
export default humanApproval;
