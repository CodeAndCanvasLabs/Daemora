import { blockedCommands } from "../config/permissions.js";
import eventBus from "../core/EventBus.js";

/**
 * Sandbox - command execution safety.
 *
 * Two modes:
 * 1. Blocklist (default): Block known dangerous commands via regex patterns.
 * 2. Docker (optional): Run in ephemeral container with restricted access.
 *
 * Blocklist catches:
 * - rm -rf /, sudo rm, mkfs, dd if=, curl|sh, chmod 777 /, > /dev/sda
 * - Fork bombs, shutdown/reboot, format commands
 */

class Sandbox {
  constructor() {
    this.mode = process.env.SANDBOX_MODE || "blocklist";
    this.blockedCount = 0;
  }

  /**
   * Check if a command is safe to execute.
   * @param {string} command - The command to check
   * @returns {{ safe: boolean, reason?: string }}
   */
  check(command) {
    if (!command || typeof command !== "string") {
      return { safe: false, reason: "Empty command" };
    }

    const cmd = command.toLowerCase().trim();

    // Check against blocked patterns
    for (const pattern of blockedCommands) {
      if (pattern.test(cmd)) {
        this.blockedCount++;
        eventBus.emitEvent("sandbox:blocked", {
          command: command.slice(0, 100),
          pattern: pattern.toString(),
        });
        return {
          safe: false,
          reason: `Command blocked by safety sandbox: matches pattern ${pattern}`,
        };
      }
    }

    // Additional heuristic checks
    if (cmd.includes(":(){ :|:& };:") || cmd.includes("fork bomb")) {
      this.blockedCount++;
      return { safe: false, reason: "Fork bomb detected" };
    }

    return { safe: true };
  }

  /**
   * Get stats.
   */
  stats() {
    return {
      mode: this.mode,
      blockedCount: this.blockedCount,
    };
  }
}

const sandbox = new Sandbox();
export default sandbox;
