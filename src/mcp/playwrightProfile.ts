/**
 * playwrightProfile — owns the active browser profile for the
 * Playwright MCP server.
 *
 * Source of truth: the `DAEMORA_BROWSER_PROFILE` setting. Default is
 * `default`. The user changes it via the Settings UI or CLI; the agent
 * never touches it.
 *
 * Whenever the setting changes, this module:
 *   1. Rewrites the `playwright` entry in `mcp.json` so its
 *      `--user-data-dir` arg points at `<dataDir>/browser/<profile>/`.
 *   2. Calls `MCPManager.connect(...)` to respawn the playwright server
 *      with the new args. The manager's connect() disconnects the
 *      existing instance first, so this is a clean swap.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { ConfigManager } from "../config/ConfigManager.js";
import type { MCPManager } from "./MCPManager.js";
import type { MCPStore } from "./MCPStore.js";

export const ACTIVE_PROFILE_SETTING = "DAEMORA_BROWSER_PROFILE";
export const DEFAULT_PROFILE = "default";

/**
 * Default viewport size for the Playwright MCP-driven browser.
 * Without this flag the MCP defaults to 1280x720, which renders at
 * roughly half-screen on modern monitors. 1920x1080 fills most
 * displays. Users can override by editing the playwright entry in
 * mcp.json directly.
 */
export const DEFAULT_VIEWPORT = "1920,1080";

/** Read the active profile from settings, with fallback. */
export function getActiveProfile(cfg: ConfigManager): string {
  const v = cfg.settings.getGeneric(ACTIVE_PROFILE_SETTING);
  return typeof v === "string" && v.length > 0 ? v : DEFAULT_PROFILE;
}

/**
 * List on-disk profiles by scanning `<dataDir>/browser/`. The CLI
 * (`daemora browser --profile <name>`) creates a dir per profile.
 * `downloads/` is filtered out — it's a sibling of profiles, not one.
 */
export function listProfiles(dataDir: string): string[] {
  const browserDir = join(dataDir, "browser");
  if (!existsSync(browserDir)) return [];
  return readdirSync(browserDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "downloads")
    .map((d) => d.name)
    .sort();
}

/**
 * Compute the `--user-data-dir` value the playwright entry should have
 * for a given profile name.
 */
export function profileUserDataDir(dataDir: string, profileName: string): string {
  return join(dataDir, "browser", profileName);
}

/**
 * Sync the playwright entry's args:
 *   - `--user-data-dir <profileDir>` (matches the active profile)
 *   - `--viewport-size <DEFAULT_VIEWPORT>` (added once for legacy entries
 *     that pre-date the viewport flag; user-provided values are kept)
 * No-op if mcp.json doesn't have a playwright entry. Returns true if
 * any change was written.
 */
export function syncPlaywrightArgs(store: MCPStore, dataDir: string, profileName: string): boolean {
  const entry = store.get("playwright");
  if (!entry) return false;
  const desired = profileUserDataDir(dataDir, profileName);
  const args = [...(entry.args ?? [])];
  let changed = false;

  // --user-data-dir
  const dirIdx = args.indexOf("--user-data-dir");
  if (dirIdx >= 0 && dirIdx + 1 < args.length) {
    if (args[dirIdx + 1] !== desired) {
      args[dirIdx + 1] = desired;
      changed = true;
    }
  } else {
    args.push("--user-data-dir", desired);
    changed = true;
  }

  // --viewport-size (only inject if absent — respect user overrides)
  const vpIdx = args.indexOf("--viewport-size");
  if (vpIdx < 0) {
    args.push("--viewport-size", DEFAULT_VIEWPORT);
    changed = true;
  }

  if (changed) store.update("playwright", { args });
  return changed;
}

/**
 * Switch the active browser profile.
 *  1. Persist the new profile name to settings.
 *  2. Sync mcp.json's playwright entry.
 *  3. Bounce the playwright MCP server so the agent sees the new
 *     profile on its next browser action.
 *
 * Idempotent: if the profile is already active and args already match,
 * does nothing.
 */
export async function setActiveProfile(
  cfg: ConfigManager,
  store: MCPStore,
  manager: MCPManager,
  dataDir: string,
  profileName: string,
): Promise<{ active: string; restarted: boolean }> {
  const trimmed = profileName.trim();
  if (!trimmed) throw new Error("profile name is required");
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new Error("profile name may only contain letters, digits, hyphens, and underscores");
  }

  const current = getActiveProfile(cfg);
  cfg.settings.setGeneric(ACTIVE_PROFILE_SETTING, trimmed);
  const argsChanged = syncPlaywrightArgs(store, dataDir, trimmed);

  // Only respawn if either the active profile changed OR the args were
  // out of sync. Both checks because a user could have manually edited
  // mcp.json between starts.
  if (current === trimmed && !argsChanged) {
    return { active: trimmed, restarted: false };
  }

  const updated = store.get("playwright");
  if (updated && updated.enabled !== false) {
    await manager.connect(updated);
  }
  return { active: trimmed, restarted: true };
}
