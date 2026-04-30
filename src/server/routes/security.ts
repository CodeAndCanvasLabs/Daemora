/**
 * /api/security/fs — read + edit the FilesystemGuard config from the UI.
 *
 *   GET  /api/security/fs   → current mode + allow + deny + effective
 *                             (post-resolution) paths.
 *   PUT  /api/security/fs   → write to settings, hot-update the live guard.
 *
 * The guard is mutated in place via `guard.update()` so all tools holding
 * a reference pick up the new policy on the very next call. Settings are
 * persisted via `cfg.settings.setGeneric` so changes survive restarts.
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";

import type { FsGuardMode } from "../../safety/FilesystemGuard.js";
import { ValidationError } from "../../util/errors.js";
import { createLogger } from "../../util/logger.js";
import type { ServerDeps } from "../index.js";

const log = createLogger("security.routes");

const MODES: readonly FsGuardMode[] = ["off", "moderate", "strict", "sandbox"];

const fsBody = z.object({
  mode: z.enum(["off", "moderate", "strict", "sandbox"] as [FsGuardMode, ...FsGuardMode[]]).optional(),
  allow: z.array(z.string().min(1).max(4096)).max(64).optional(),
  deny: z.array(z.string().min(1).max(4096)).max(64).optional(),
});

function readListSetting(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === "string");
  if (typeof value === "string" && value.length > 0) {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function validatePath(p: string): void {
  if (!p) throw new ValidationError("Path cannot be empty");
  if (!p.startsWith("/") && !/^[A-Za-z]:[\\\/]/.test(p)) {
    throw new ValidationError(`Path must be absolute: ${p}`);
  }
  if (p.includes("\0")) throw new ValidationError(`Path contains NUL: ${p}`);
}

export function mountSecurityRoutes(app: Express, deps: ServerDeps): void {
  /**
   * Current FilesystemGuard config + the resolved (canonical) view of
   * the allow / deny lists the live guard is enforcing right now.
   */
  app.get("/api/security/fs", (_req: Request, res: Response) => {
    const liveDescribe = deps.guard.describe();
    const allow = readListSetting(deps.cfg.settings.getGeneric("DAEMORA_FS_ALLOW"));
    const deny = readListSetting(deps.cfg.settings.getGeneric("DAEMORA_FS_DENY"));
    res.json({
      mode: liveDescribe.mode,
      allow,                    // raw user-entered values (what to display in the editor)
      deny,
      effective: {
        // What the live guard is actually enforcing — handy for debugging
        // when a user wonders why their `~` got expanded or a path got
        // canonicalised through a symlink.
        mode: liveDescribe.mode,
        allow: liveDescribe.allow,
        deny: liveDescribe.deny,
        dataDir: liveDescribe.dataDir ?? null,
      },
      modes: MODES,
      doc: {
        off: "No checks. Escape hatch — only for trusted environments.",
        moderate: "Block sensitive dirs (.ssh, .aws, /etc, ...) + Daemora's own DB. Default.",
        strict: "Only $HOME and the configured allow-list paths are reachable.",
        sandbox: "Only the configured allow-list paths are reachable. $HOME is NOT auto-included — use this to confine the agent to a specific project directory.",
      },
    });
  });

  /**
   * Update the FilesystemGuard. Body:
   *   { mode?: "off"|"moderate"|"strict"|"sandbox",
   *     allow?: string[],
   *     deny?: string[] }
   *
   * Persists each provided field to settings. Then mutates the live guard
   * via `update()` so all FS-touching tools immediately see the new policy.
   */
  app.put("/api/security/fs", (req: Request, res: Response) => {
    const parsed = fsBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError(parsed.error.message);

    if (parsed.data.allow) parsed.data.allow.forEach(validatePath);
    if (parsed.data.deny) parsed.data.deny.forEach(validatePath);

    if (parsed.data.mode !== undefined) {
      deps.cfg.settings.setGeneric("DAEMORA_FS_GUARD", parsed.data.mode);
    }
    if (parsed.data.allow !== undefined) {
      deps.cfg.settings.setGeneric("DAEMORA_FS_ALLOW", parsed.data.allow);
    }
    if (parsed.data.deny !== undefined) {
      deps.cfg.settings.setGeneric("DAEMORA_FS_DENY", parsed.data.deny);
    }

    // Read back the merged state so we update the guard with the FULL
    // current config — `update()` replaces, doesn't merge per-field.
    const mode = (deps.cfg.settings.getGeneric("DAEMORA_FS_GUARD") as FsGuardMode | undefined) ?? "moderate";
    const allow = readListSetting(deps.cfg.settings.getGeneric("DAEMORA_FS_ALLOW"));
    const deny = readListSetting(deps.cfg.settings.getGeneric("DAEMORA_FS_DENY"));
    deps.guard.update({ mode, extraAllow: allow, extraDeny: deny });

    log.info({ mode, allow, deny }, "filesystem guard reconfigured");

    const live = deps.guard.describe();
    res.json({
      mode,
      allow,
      deny,
      effective: {
        mode: live.mode,
        allow: live.allow,
        deny: live.deny,
        dataDir: live.dataDir ?? null,
      },
    });
  });
}
