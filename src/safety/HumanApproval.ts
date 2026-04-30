/**
 * HumanApproval — pauses the agent and asks the user before running
 * dangerous / irreversible tools.
 *
 * Flow:
 *   1. AgentLoop / TaskRunner calls `requestApproval(taskId, toolName, params, channelMeta)`.
 *   2. Promise-based wait → event `approval:request` fires on this
 *      emitter. A channel handler (Telegram, Discord, HTTP) delivers
 *      the prompt to the end user and asks them to `approve <reqId>`
 *      or `deny <reqId>`.
 *   3. When the user replies, the channel calls `handleReply(text)`.
 *      The matching promise resolves to `true` / `false`.
 *   4. If no reply within `timeoutMs`, the request resolves with
 *      `onTimeout` (default `"deny"` — fail-safe for irreversible ops).
 *
 * Modes:
 *   • `auto`           — no pauses, fully autonomous.
 *   • `dangerous-only` — default. Pauses only on tools in DANGEROUS_TOOLS.
 *   • `every-tool`     — pauses on every tool call (debug / high-assurance).
 */

import { EventEmitter } from "node:events";

import { createLogger } from "../util/logger.js";

const log = createLogger("human-approval");

export type ApprovalMode = "auto" | "dangerous-only" | "every-tool";

/**
 * Tools that get flagged as dangerous under the default mode.
 * Only *external* / irreversible side-effects (things you can't un-do
 * without apologising to another human). File writes, shell commands,
 * memory writes etc. stay autonomous — they live inside the agent's
 * own sandbox.
 */
const DANGEROUS_TOOLS: ReadonlySet<string> = new Set([
  "send_email",
  "message_channel",
  "send_file",
  "broadcast",
  "cron",
  "create_poll",
]);

export interface ApprovalRequest {
  readonly requestId: string;
  readonly taskId: string;
  readonly toolName: string;
  readonly params: unknown;
  readonly channelMeta?: Record<string, unknown>;
  readonly timeoutMs: number;
  readonly message: string;
}

export interface HumanApprovalOpts {
  readonly timeoutMs?: number;
  readonly onTimeout?: "deny" | "allow";
}

interface Pending {
  readonly resolve: (approved: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly taskId: string;
  readonly toolName: string;
  readonly params: unknown;
}

export class HumanApproval extends EventEmitter {
  private readonly pending = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private readonly onTimeout: "deny" | "allow";

  constructor(opts: HumanApprovalOpts = {}) {
    super();
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.onTimeout = opts.onTimeout ?? "deny";
  }

  /** Is an approval required for this tool call given the mode? */
  needsApproval(toolName: string, mode: ApprovalMode): boolean {
    if (!mode || mode === "auto") return false;
    if (mode === "every-tool") return true;
    return DANGEROUS_TOOLS.has(toolName);
  }

  /**
   * Register a pending approval and return a Promise that resolves when
   * the user (or the timeout) decides.
   */
  requestApproval(
    taskId: string,
    toolName: string,
    params: unknown,
    channelMeta?: Record<string, unknown>,
  ): Promise<boolean> {
    const requestId = `apr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const preview = typeof params === "object" ? safeJSON(params).slice(0, 160) : String(params).slice(0, 160);

    log.info({ requestId, toolName, taskId }, "approval request opened");

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        const decision = this.onTimeout === "allow";
        log.info({ requestId, decision }, "approval timed out");
        this.emit("resolved", { requestId, taskId, toolName, approved: decision, source: "timeout" });
        resolve(decision);
      }, this.timeoutMs);

      this.pending.set(requestId, { resolve, timer, taskId, toolName, params });

      const req: ApprovalRequest = {
        requestId,
        taskId,
        toolName,
        params,
        ...(channelMeta ? { channelMeta } : {}),
        timeoutMs: this.timeoutMs,
        message: this.buildMessage(requestId, toolName, preview),
      };
      this.emit("request", req);
    });
  }

  /** Approve explicitly by requestId. */
  approve(requestId: string, source = "user"): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    log.info({ requestId, source }, "approved");
    this.emit("resolved", { requestId, taskId: pending.taskId, toolName: pending.toolName, approved: true, source });
    pending.resolve(true);
    return true;
  }

  /** Deny explicitly by requestId. */
  deny(requestId: string, source = "user"): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    log.info({ requestId, source }, "denied");
    this.emit("resolved", { requestId, taskId: pending.taskId, toolName: pending.toolName, approved: false, source });
    pending.resolve(false);
    return true;
  }

  /**
   * Parse a free-form user reply and dispatch approve / deny for the
   * embedded requestId. Returns true iff a pending request was handled.
   */
  handleReply(text: string): boolean {
    const match = text.match(/apr-[a-z0-9]+-[a-z0-9]+/i);
    if (!match) return false;
    const requestId = match[0];
    if (!this.pending.has(requestId)) return false;
    const approved = /\b(yes|approve|allow|ok|okay|go|run|do it|confirm|✓|👍)\b/i.test(text);
    return approved ? this.approve(requestId) : this.deny(requestId);
  }

  pendingList(): readonly { requestId: string; taskId: string; toolName: string }[] {
    return [...this.pending.entries()].map(([id, p]) => ({
      requestId: id,
      taskId: p.taskId,
      toolName: p.toolName,
    }));
  }

  private buildMessage(requestId: string, toolName: string, paramPreview: string): string {
    const lines: (string | null)[] = [
      "⚠️ Agent wants to run a tool that requires your approval:",
      "",
      `  Tool: ${toolName}`,
      paramPreview ? `  Args: ${paramPreview}` : null,
      "",
      "Reply with:",
      `  ✅ approve ${requestId}`,
      `  ❌ deny ${requestId}`,
      "",
      `(Auto-${this.onTimeout}s in ${Math.round(this.timeoutMs / 1000)}s if no reply)`,
    ];
    return lines.filter((l): l is string => l !== null).join("\n");
  }
}

function safeJSON(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

export const humanApproval = new HumanApproval();
