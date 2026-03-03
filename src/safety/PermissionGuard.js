import { config } from "../config/default.js";
import { permissionTiers } from "../config/permissions.js";
import eventBus from "../core/EventBus.js";

/**
 * Permission Guard - enforces tool access based on permission tiers.
 *
 * 3 tiers:
 * - minimal: read-only tools only
 * - standard: + write/edit/sandboxed commands
 * - full: everything including email, unsandboxed commands, agents
 */
class PermissionGuard {
  constructor() {
    this.tier = config.permissionTier;
  }

  /**
   * Check if a tool is allowed under the current permission tier.
   * @param {string} toolName - Name of the tool
   * @param {object} [params] - Tool parameters (for fine-grained checks)
   * @returns {{ allowed: boolean, reason?: string }}
   */
  check(toolName, params) {
    const tierConfig = permissionTiers[this.tier];
    if (!tierConfig) {
      return { allowed: false, reason: `Unknown permission tier: ${this.tier}` };
    }

    // MCP tools (mcp__server__tool) are user-configured integrations.
    // Allow them in standard and full tiers - the user explicitly set them up.
    if (toolName.startsWith("mcp__")) {
      if (this.tier === "minimal") {
        eventBus.emitEvent("permission:denied", { toolName, tier: this.tier });
        return { allowed: false, reason: `MCP tools not available in minimal permission tier.` };
      }
      return { allowed: true };
    }

    // Check if tool is in the allowed list
    if (!tierConfig.allowedTools.includes(toolName) && !tierConfig.allowedTools.includes("*")) {
      eventBus.emitEvent("permission:denied", { toolName, tier: this.tier });
      return {
        allowed: false,
        reason: `Tool "${toolName}" not allowed in "${this.tier}" permission tier. Allowed: ${tierConfig.allowedTools.join(", ")}`,
      };
    }

    return { allowed: true };
  }

  /**
   * Filter a tool map to only include allowed tools.
   */
  filterTools(tools) {
    const tierConfig = permissionTiers[this.tier];
    if (!tierConfig) return tools;
    if (tierConfig.allowedTools.includes("*")) return tools;

    const filtered = {};
    for (const [name, fn] of Object.entries(tools)) {
      // MCP tools pass through in standard/full tier
      if (name.startsWith("mcp__")) {
        if (this.tier !== "minimal") filtered[name] = fn;
        continue;
      }
      if (tierConfig.allowedTools.includes(name)) {
        filtered[name] = fn;
      }
    }
    return filtered;
  }

  /**
   * Get current tier name.
   */
  getTier() {
    return this.tier;
  }
}

const permissionGuard = new PermissionGuard();
export default permissionGuard;
