/**
 * ExecApproval — dedicated approval gate for shell commands.
 *
 * HumanApproval covers tool-level approvals (send_email, broadcast, …);
 * ExecApproval is the finer-grained sibling that the `execute_command`
 * tool consults specifically for shell payloads. Matching patterns:
 *
 *   • `rm -rf`, `sudo`, `kill -9`, `shutdown`, `reboot`, `mkfs`, `dd if=`
 *   • Pipe-to-shell installers (`curl|sh`, `wget|bash`)
 *   • Destructive git (`git push --force`, `git reset --hard`)
 *   • `npm publish`, `docker rm`, `docker system prune`
 *   • `drop table/database`
 *
 * Modes (from settings or env `APPROVAL_MODE`):
 *   • `off`             — never pause.
 *   • `dangerous-only`  — only pause on pattern match (default).
 *   • `all`             — pause on every shell invocation.
 *
 * Pending requests are listable + resolvable via an HTTP API (the
 * server wires this to `/api/exec-approvals`). Returns `"allow"` /
 * `"deny"` (with `"allow-once"` mapped to `"allow"` for the caller —
 * TTL logic for persistent allows can live on top if needed).
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import { createLogger } from "../util/logger.js";

const log = createLogger("exec-approval");

export type ExecMode = "off" | "dangerous-only" | "all";
export type Decision = "allow" | "allow-once" | "deny";
export type EffectiveDecision = "allow" | "deny";

const DANGEROUS_PATTERNS: readonly RegExp[] = [
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

export interface ExecApprovalOpts {
  readonly mode?: ExecMode;
  readonly timeoutMs?: number;
}

interface Pending {
  readonly command: string;
  readonly taskId: string;
  readonly createdAt: number;
  readonly resolve: (decision: EffectiveDecision) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class ExecApproval extends EventEmitter {
  private _mode: ExecMode;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, Pending>();

  constructor(opts: ExecApprovalOpts = {}) {
    super();
    this._mode = opts.mode ?? ((process.env["APPROVAL_MODE"] as ExecMode | undefined) ?? "off");
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  get mode(): ExecMode {
    return this._mode;
  }

  setMode(mode: ExecMode): void {
    this._mode = mode;
    log.info({ mode }, "exec approval mode changed");
  }

  needsApproval(command: string): boolean {
    if (this._mode === "off") return false;
    if (this._mode === "all") return true;
    return DANGEROUS_PATTERNS.some((p) => p.test(command));
  }

  requestApproval(command: string, taskId: string): Promise<EffectiveDecision> {
    return new Promise<EffectiveDecision>((resolve) => {
      const approvalId = randomUUID().slice(0, 12);
      const timer = setTimeout(() => {
        this.pending.delete(approvalId);
        log.info({ approvalId }, "exec approval timed out → deny");
        resolve("deny");
      }, this.timeoutMs);

      const pending: Pending = {
        command,
        taskId,
        createdAt: Date.now(),
        resolve,
        timer,
      };
      this.pending.set(approvalId, pending);

      log.info({ approvalId, command: command.slice(0, 120), taskId }, "exec approval requested");
      this.emit("request", {
        approvalId,
        command,
        taskId,
        createdAt: pending.createdAt,
        timeoutMs: this.timeoutMs,
      });
    });
  }

  /** Resolve a pending approval. Returns true if the id was found. */
  resolveApproval(approvalId: string, decision: Decision): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(approvalId);
    const effective: EffectiveDecision = decision === "allow-once" ? "allow" : decision;
    log.info({ approvalId, decision }, "exec approval resolved");
    this.emit("resolved", { approvalId, decision, effective });
    entry.resolve(effective);
    return true;
  }

  /** Snapshot of currently-pending approvals. Safe for UI consumption. */
  listPending(): readonly {
    id: string;
    command: string;
    taskId: string;
    createdAt: number;
    expiresInMs: number;
  }[] {
    const now = Date.now();
    return [...this.pending.entries()].map(([id, entry]) => ({
      id,
      command: entry.command,
      taskId: entry.taskId,
      createdAt: entry.createdAt,
      expiresInMs: Math.max(0, this.timeoutMs - (now - entry.createdAt)),
    }));
  }
}

export const execApproval = new ExecApproval();
