/**
 * Exec Approval Manager - interactive approval gates for dangerous commands.
 *
 * When approval mode is enabled and a command matches dangerous patterns,
 * the agent loop pauses and waits for user approval via the API.
 *
 * Config: approval.mode = "off" | "dangerous-only" | "all"
 * API:
 *   GET  /api/approvals       - list pending approvals
 *   POST /api/approvals/:id   - approve/deny { decision: "allow" | "allow-once" | "deny" }
 */

import { v4 as uuidv4 } from "uuid";

// Dangerous command patterns
const DANGEROUS_PATTERNS = [
  /\brm\s+(-rf?|--recursive)\b/i,
  /\bsudo\b/,
  /\bdrop\s+(table|database)\b/i,
  /\bkill\s+-9\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bcurl\b.*\|\s*(sh|bash|zsh)\b/,
  /\bwget\b.*\|\s*(sh|bash|zsh)\b/,
  /\bnpm\s+publish\b/,
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bdocker\s+rm\b/,
  /\bdocker\s+system\s+prune\b/,
];

class ExecApprovalManager {
  constructor() {
    // approvalId → { command, taskId, createdAt, resolve, timer }
    this._pending = new Map();
    this._timeoutMs = 60_000; // 60 seconds default
    this._mode = process.env.APPROVAL_MODE || "off"; // "off" | "dangerous-only" | "all"
  }

  get mode() {
    return this._mode;
  }

  /**
   * Check if a command needs approval.
   */
  needsApproval(command) {
    if (this._mode === "off") return false;
    if (this._mode === "all") return true;
    // "dangerous-only" - check against patterns
    return DANGEROUS_PATTERNS.some(p => p.test(command));
  }

  /**
   * Request approval for a command. Returns a Promise that resolves with the decision.
   * @param {string} command
   * @param {string} taskId
   * @returns {Promise<"allow"|"deny">}
   */
  requestApproval(command, taskId) {
    return new Promise((resolve) => {
      const approvalId = uuidv4().slice(0, 12);

      const timer = setTimeout(() => {
        this._pending.delete(approvalId);
        console.log(`[ExecApproval] Timeout for ${approvalId} - denying`);
        resolve("deny");
      }, this._timeoutMs);

      this._pending.set(approvalId, {
        command,
        taskId,
        createdAt: new Date().toISOString(),
        resolve,
        timer,
      });

      console.log(`[ExecApproval] Waiting for approval ${approvalId}: "${command.slice(0, 80)}"`);
    });
  }

  /**
   * Resolve a pending approval.
   * @param {string} approvalId
   * @param {"allow"|"allow-once"|"deny"} decision
   * @returns {boolean} true if found and resolved
   */
  resolveApproval(approvalId, decision) {
    const entry = this._pending.get(approvalId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this._pending.delete(approvalId);

    const effective = decision === "allow-once" ? "allow" : decision;
    console.log(`[ExecApproval] ${approvalId} → ${decision}`);
    entry.resolve(effective);
    return true;
  }

  /**
   * List all pending approvals (for API).
   */
  listPending() {
    return [...this._pending.entries()].map(([id, entry]) => ({
      id,
      command: entry.command,
      taskId: entry.taskId,
      createdAt: entry.createdAt,
      expiresIn: Math.max(0, this._timeoutMs - (Date.now() - new Date(entry.createdAt).getTime())),
    }));
  }
}

const execApproval = new ExecApprovalManager();
export default execApproval;
