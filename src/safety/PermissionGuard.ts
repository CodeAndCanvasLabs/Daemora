/**
 * PermissionGuard — tier-based tool access control.
 *
 * Three tiers (cumulative):
 *   • **minimal**  — read-only: file reads, web fetch/search, memory reads, vision.
 *   • **standard** — adds writes, shell, channels, media generation, desktop, memory writes.
 *   • **full**     — adds email, channel outbound, team orchestration, MCP mgmt, reload.
 *
 * `check(toolName)` returns `{allowed, reason?}` for the current tier.
 * MCP tools (`mcp__<server>__<tool>`) are user-configured integrations;
 * they pass in standard / full but are blocked in minimal.
 *
 * The tier is read from the settings store at construction and can be
 * updated live via `setTier()`.
 */

import { EventEmitter } from "node:events";

import type { ConfigManager } from "../config/ConfigManager.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("permission-guard");

export type PermissionTier = "minimal" | "standard" | "full";

export interface TierConfig {
  readonly name: string;
  readonly description: string;
  /** Exact tool name list. `*` means all tools allowed. */
  readonly allowedTools: readonly string[];
}

export interface PermissionCheck {
  readonly allowed: boolean;
  readonly reason?: string;
}

export const PERMISSION_TIERS: Record<PermissionTier, TierConfig> = {
  minimal: {
    name: "Minimal (Read-Only)",
    description: "Agent can read files, search the web, and recall memory. No writes, no shell, no communication.",
    allowedTools: [
      // Filesystem reads
      "read_file", "list_directory", "glob", "grep",
      // Web reads
      "fetch_url", "web_fetch", "web_search",
      // Memory reads
      "memory_recall",
      // Transcription (read-only media). image_analysis was retired —
      // native multimodal handles in-chat images, and the file-scan
      // pipeline calls describeImage() internally.
      "transcribe_audio",
      // Read PDF
      "read_pdf",
    ],
  },
  standard: {
    name: "Standard",
    description: "Agent can read + write files, run commands, browse, generate media, and manage memory.",
    allowedTools: [
      // Filesystem
      "read_file", "write_file", "edit_file", "apply_patch",
      "list_directory", "glob", "grep", "create_document", "read_pdf",
      // Shell
      "execute_command",
      // Web
      "fetch_url", "web_fetch", "web_search",
      // AI / media
      "transcribe_audio", "text_to_speech",
      "generate_image", "generate_video", "generate_music", "image_ops",
      // Desktop control is provided by the `computer-use` MCP server
      // (zavora-ai). Enable it from MCP settings; tools are reached via
      // use_mcp. They are not gated here.
      // System
      "clipboard", "screen_capture", "reply_to_user",
      // Memory
      "memory_save", "memory_recall",
      // Orchestration
      "use_crew", "parallel_crew", "use_mcp",
      // Planning / tracking
      "project", "team", "cron", "goal", "watcher",
      // Git
      "git",
    ],
  },
  full: {
    name: "Full",
    description: "All tools unlocked — email/channels/MCP management/reload/broadcast enabled.",
    allowedTools: ["*"],
  },
};

function isValidTier(t: string): t is PermissionTier {
  return t === "minimal" || t === "standard" || t === "full";
}

export class PermissionGuard extends EventEmitter {
  private tier: PermissionTier;

  constructor(private readonly cfg: ConfigManager) {
    super();
    const raw = ((cfg.settings.getGeneric("PERMISSION_TIER") as string | undefined) ?? "standard");
    this.tier = isValidTier(raw) ? raw : "standard";
    log.info({ tier: this.tier }, "permission guard initialised");
  }

  /** Live tier rename — emits "tier:changed". */
  setTier(tier: PermissionTier): void {
    if (tier === this.tier) return;
    const prev = this.tier;
    this.tier = tier;
    log.info({ prev, tier }, "permission tier changed");
    this.emit("tier:changed", { prev, tier });
  }

  getTier(): PermissionTier {
    return this.tier;
  }

  getConfig(): TierConfig {
    return PERMISSION_TIERS[this.tier];
  }

  /**
   * Is this tool allowed under the current tier? Returns
   * `{allowed: false, reason}` with a user-facing message otherwise.
   */
  check(toolName: string): PermissionCheck {
    const cfg = PERMISSION_TIERS[this.tier];

    // MCP tools — user-configured integrations pass through in standard+.
    if (toolName.startsWith("mcp__")) {
      if (this.tier === "minimal") {
        this.emit("denied", { toolName, tier: this.tier });
        return { allowed: false, reason: `MCP tools blocked in '${this.tier}' tier.` };
      }
      return { allowed: true };
    }

    if (cfg.allowedTools.includes("*") || cfg.allowedTools.includes(toolName)) {
      return { allowed: true };
    }

    this.emit("denied", { toolName, tier: this.tier });
    return {
      allowed: false,
      reason:
        `Tool '${toolName}' is not allowed in '${this.tier}' tier. ` +
        `Switch to 'standard' or 'full' in Settings if you need it.`,
    };
  }

  /**
   * Return only the tool names that are allowed — used by the agent
   * loop when composing the per-turn tool set.
   */
  filterToolNames(names: readonly string[]): string[] {
    return names.filter((n) => this.check(n).allowed);
  }
}
