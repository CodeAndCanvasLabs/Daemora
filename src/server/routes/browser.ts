/**
 * /api/browser/profile — read + switch the active browser profile.
 *
 * The active profile is stored in the `DAEMORA_BROWSER_PROFILE` setting
 * and drives the `--user-data-dir` arg of the `playwright` MCP server.
 * The agent never touches this — it's user-controlled. When the user
 * switches profiles, this route rewrites mcp.json and bounces the
 * playwright MCP server so the next browser action picks up the new
 * profile's cookies and logins.
 *
 *   GET  /api/browser/profile  → { active, available, profileDir, hasLoginData }
 *   PUT  /api/browser/profile  → { name } → { active, restarted }
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Express, Request, Response } from "express";
import { z } from "zod";

import { ACTIVE_PROFILE_SETTING, DEFAULT_PROFILE, getActiveProfile, listProfiles, profileUserDataDir, setActiveProfile } from "../../mcp/playwrightProfile.js";
import { ValidationError } from "../../util/errors.js";
import { createLogger } from "../../util/logger.js";
import type { ServerDeps } from "../index.js";

const log = createLogger("browser.routes");

const switchBody = z.object({
  name: z.string().min(1).max(64),
});

/** A profile dir is "real" (has saved logins) if it contains the
 *  Chromium `Default/Cookies` SQLite file or `Local Storage`. We use
 *  this to flag empty profile dirs in the UI so the user can tell
 *  which ones they've actually logged into. */
function hasLoginArtifacts(profileDir: string): boolean {
  if (!existsSync(profileDir)) return false;
  return existsSync(join(profileDir, "Default", "Cookies"))
      || existsSync(join(profileDir, "Default", "Local Storage"))
      || existsSync(join(profileDir, "Default", "Login Data"));
}

export function mountBrowserRoutes(app: Express, deps: ServerDeps): void {
  app.get("/api/browser/profile", (_req: Request, res: Response) => {
    const dataDir = deps.cfg.env.dataDir;
    const active = getActiveProfile(deps.cfg);
    const names = listProfiles(dataDir);
    const profiles = names.map((name) => ({
      name,
      hasLoginData: hasLoginArtifacts(profileUserDataDir(dataDir, name)),
    }));
    // Make sure the active profile is in the list even if its dir
    // doesn't exist yet (first boot, never opened).
    if (!profiles.some((p) => p.name === active)) {
      profiles.unshift({ name: active, hasLoginData: false });
    }
    res.json({
      active,
      profiles,
      profileDir: profileUserDataDir(dataDir, active),
      defaultProfile: DEFAULT_PROFILE,
      settingKey: ACTIVE_PROFILE_SETTING,
    });
  });

  app.put("/api/browser/profile", async (req: Request, res: Response) => {
    const parsed = switchBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const dataDir = deps.cfg.env.dataDir;
    try {
      const result = await setActiveProfile(deps.cfg, deps.mcpStore, deps.mcp, dataDir, parsed.data.name);
      log.info({ active: result.active, restarted: result.restarted }, "browser profile switched");
      res.json({
        active: result.active,
        restarted: result.restarted,
        profileDir: profileUserDataDir(dataDir, result.active),
      });
    } catch (e) {
      throw new ValidationError((e as Error).message);
    }
  });
}
