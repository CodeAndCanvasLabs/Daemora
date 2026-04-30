/**
 * Sandbox — blocklist-first command safety gate.
 *
 * Complements CommandGuard (which catches secret-exfil / privesc) with
 * a tighter list of outright destructive patterns:
 *
 *   • `rm -rf /`, `rm -rf ~`, `:(){ :|:& };:` (fork bomb)
 *   • `mkfs`, `dd if=…of=/dev/…`, `chmod 777 /`
 *   • `> /dev/sd*`, `shutdown`, `reboot`, `halt`, `init 0`
 *   • Pipe-to-shell installers (`curl|sh`, `wget|bash`)
 *
 * Returns `{safe: false, reason}` with a user-readable string on a hit.
 * Keep this cheap — it runs on every `execute_command` call.
 *
 * Docker-sandbox mode (see DockerSandbox.ts) layers on top: after
 * blocklist passes, runs the command inside an ephemeral container
 * with no host network + read-only root.
 */

import { EventEmitter } from "node:events";

import { createLogger } from "../util/logger.js";

const log = createLogger("sandbox");

const BLOCKED_PATTERNS: readonly RegExp[] = [
  // Filesystem nukes.
  /\brm\s+-rf?\s+\/\s*$/i,
  /\brm\s+-rf?\s+\/[^/].*$/i,
  /\brm\s+-rf?\s+~\s*$/i,
  /\brm\s+-rf?\s+\*\s*$/i,
  // Fork bomb.
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/,
  // Disk / filesystem formatting.
  /\bmkfs(?:\.[a-z0-9]+)?\b/i,
  /\bdd\s+if=.*\bof=\/dev\//i,
  // Wide chmod on root.
  /\bchmod\s+(?:-R\s+)?[0-7]{3,4}\s+\/\s*$/i,
  // Device writes.
  />\s*\/dev\/(?:sd[a-z]|hd[a-z]|nvme\d+)/i,
  // Power management.
  /\b(?:shutdown|reboot|halt|poweroff)\b/i,
  /\binit\s+[06]\b/,
  // Pipe-to-shell installers.
  /\bcurl\b[^;|&\n]*\|\s*(?:sh|bash|zsh)\b/i,
  /\bwget\b[^;|&\n]*\|\s*(?:sh|bash|zsh)\b/i,
];

export type SandboxMode = "blocklist" | "docker" | "off";

export interface SandboxCheck {
  readonly safe: boolean;
  readonly reason?: string;
}

export class Sandbox extends EventEmitter {
  private _mode: SandboxMode;
  private blockedCount = 0;

  constructor(mode?: SandboxMode) {
    super();
    this._mode = mode ?? ((process.env["SANDBOX_MODE"] as SandboxMode | undefined) ?? "blocklist");
  }

  get mode(): SandboxMode {
    return this._mode;
  }

  setMode(mode: SandboxMode): void {
    this._mode = mode;
    log.info({ mode }, "sandbox mode changed");
  }

  check(command: string): SandboxCheck {
    if (!command || typeof command !== "string") {
      return { safe: false, reason: "Empty command" };
    }
    if (this._mode === "off") return { safe: true };

    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(command)) {
        this.blockedCount++;
        log.warn({ pattern: pattern.toString(), sample: command.slice(0, 120) }, "sandbox blocked");
        this.emit("blocked", { command: command.slice(0, 200), pattern: pattern.toString() });
        return {
          safe: false,
          reason: `Command blocked by sandbox (matches ${pattern}).`,
        };
      }
    }
    return { safe: true };
  }

  stats(): { mode: SandboxMode; blockedCount: number } {
    return { mode: this._mode, blockedCount: this.blockedCount };
  }
}

export const sandbox = new Sandbox();
