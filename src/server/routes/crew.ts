/**
 * /api/crew — list crews + fetch manifest details + live-edit the
 * model / temperature on a per-crew basis.
 *
 * Source of truth for crew config is the on-disk `crew/<folder>/plugin.json`.
 * The PUT profile route:
 *   1. Finds the plugin.json for the given id (scan crew dir, match by id).
 *   2. Merges the new profile fields in and writes back.
 *   3. Re-runs CrewLoader for this crew only, then registers the fresh
 *      LoadedCrew on the CrewRegistry (replacing the old entry).
 *   4. Invalidates the agent's cached system prompt so the next
 *      delegation picks up the new model immediately — no restart.
 *
 * Crew runtime (CrewAgentRunner) already reads `crew.manifest.profile.model`
 * at call time, so a fresh registry entry = fresh model selection on
 * the very next `useCrew` invocation.
 */

import { exec as execCb } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { Express, Request, Response } from "express";
import { z } from "zod";

import { NotFoundError, ValidationError } from "../../util/errors.js";
import { createLogger } from "../../util/logger.js";
import type { ServerDeps } from "../index.js";

const exec = promisify(execCb);

const log = createLogger("crew.routes");

const DISABLED_KEY = "DAEMORA_DISABLED_CREWS";

const profileBody = z.object({
  model: z.string().min(1).max(256).nullable().optional(),
  temperature: z.number().min(0).max(2).optional(),
  systemPrompt: z.string().min(1).max(32_000).optional(),
});

const installBody = z.object({
  pkg: z.string().min(1).max(256).regex(
    /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[^\s;|&`$<>(){}[\]]+)?$/i,
    "pkg must be a valid npm package spec (no shell metachars)",
  ),
});

const configBody = z.object({
  updates: z.record(z.string()),
});

function readDisabledSet(deps: ServerDeps): Set<string> {
  const raw = deps.cfg.settings.getGeneric(DISABLED_KEY);
  if (Array.isArray(raw)) return new Set(raw.filter((x): x is string => typeof x === "string"));
  return new Set();
}

function writeDisabledSet(deps: ServerDeps, set: Set<string>): void {
  deps.cfg.settings.setGeneric(DISABLED_KEY, Array.from(set));
}

export function mountCrewRoutes(app: Express, deps: ServerDeps): void {
  // Note: GET /api/crew and GET /api/crew/:id are served by
  // mountCompatRoutes which registers them earlier in the chain.
  // Only new endpoints live here.

  /**
   * Patch a crew's profile (model / temperature / system prompt).
   * Writes to plugin.json on disk, reloads that crew in the registry,
   * invalidates the agent's system prompt cache.
   */
  app.put("/api/crew/:id/profile", async (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const parsed = profileBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError(parsed.error.message);

    // Validate the model id format + provider availability early, so
    // the user gets a clear error instead of a runtime crash mid-turn.
    if (parsed.data.model) {
      const colonIdx = parsed.data.model.indexOf(":");
      if (colonIdx <= 0 || colonIdx === parsed.data.model.length - 1) {
        throw new ValidationError(`Invalid model id "${parsed.data.model}". Expected "provider:model".`);
      }
      const providerId = parsed.data.model.slice(0, colonIdx);
      // providerAvailable() throws on unknown providers — wrap so the
      // caller sees a 400 instead of a 500.
      try {
        if (!deps.models.providerAvailable(providerId as never)) {
          throw new ValidationError(
            `Provider "${providerId}" is not configured. Add its API key in Settings → Secrets first.`,
          );
        }
      } catch (e) {
        if (e instanceof ValidationError) throw e;
        throw new ValidationError(`Unknown provider "${providerId}".`);
      }
    }

    const manifestPath = await findManifestPathForId(deps.crewLoader.rootDir, id);
    if (!manifestPath) throw new NotFoundError(`No plugin.json on disk matches crew id "${id}".`);

    // Read, merge, write.
    let raw: string;
    try { raw = await readFile(manifestPath, "utf-8"); }
    catch { throw new NotFoundError(`Can't read ${manifestPath}.`); }
    let json: Record<string, unknown>;
    try { json = JSON.parse(raw) as Record<string, unknown>; }
    catch (e) { throw new ValidationError(`plugin.json is malformed: ${(e as Error).message}`); }

    const profile = { ...((json["profile"] ?? {}) as Record<string, unknown>) };
    if (parsed.data.model !== undefined) profile["model"] = parsed.data.model; // null clears
    if (parsed.data.temperature !== undefined) profile["temperature"] = parsed.data.temperature;
    if (parsed.data.systemPrompt !== undefined) profile["systemPrompt"] = parsed.data.systemPrompt;
    json["profile"] = profile;
    await writeFile(manifestPath, JSON.stringify(json, null, 2) + "\n", "utf-8");

    // Hot-reload: CrewLoader.loadOne() re-scans the whole dir and
    // returns the matching crew. Registering it replaces the old
    // LoadedCrew entry in CrewRegistry.register (set-based).
    const fresh = await deps.crewLoader.loadOne(id, deps.agent.tools);
    if (!fresh) throw new ValidationError(`Reload failed — plugin.json may no longer parse.`);
    deps.crews.register(fresh);
    deps.agent.invalidateSystemPromptCache();

    log.info({ id, model: profile["model"] ?? null }, "crew profile updated");
    res.json({
      id,
      profile,
      note: "Changes take effect on the next delegation.",
    });
  });

  /**
   * Enable a crew. If it's loaded but not registered (disabled), re-register
   * via the loader and clear the disabled flag in settings.
   */
  app.post("/api/crew/:id/enable", async (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const fresh = await deps.crewLoader.loadOne(id, deps.agent.tools);
    if (!fresh) throw new NotFoundError(`No plugin.json on disk matches crew id "${id}".`);
    deps.crews.register(fresh);
    deps.agent.invalidateSystemPromptCache();

    const disabled = readDisabledSet(deps);
    if (disabled.delete(id)) writeDisabledSet(deps, disabled);

    log.info({ id }, "crew enabled");
    res.json({ id, enabled: true });
  });

  /**
   * Disable a crew. Unregisters from the live registry (so the main agent
   * stops seeing it) and persists the disabled state so it stays disabled
   * after a restart.
   */
  app.post("/api/crew/:id/disable", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    if (!deps.crews.has(id)) {
      // Already disabled — still record the intent so a future enable round-trips.
      const disabled = readDisabledSet(deps);
      disabled.add(id);
      writeDisabledSet(deps, disabled);
      log.info({ id }, "crew disable (no-op, already not registered)");
      return res.json({ id, enabled: false });
    }
    deps.crews.unregister(id);
    deps.agent.invalidateSystemPromptCache();

    const disabled = readDisabledSet(deps);
    disabled.add(id);
    writeDisabledSet(deps, disabled);

    log.info({ id }, "crew disabled");
    res.json({ id, enabled: false });
  });

  /**
   * Hot-reload a crew from disk. Same path as the profile PUT uses
   * after writing — re-parses plugin.json, re-resolves tools, registers
   * the fresh entry on top of the old one in the registry.
   */
  app.post("/api/crew/:id/reload", async (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const fresh = await deps.crewLoader.loadOne(id, deps.agent.tools);
    if (!fresh) throw new NotFoundError(`No plugin.json on disk matches crew id "${id}".`);
    deps.crews.register(fresh);
    deps.agent.invalidateSystemPromptCache();
    log.info({ id }, "crew reloaded");
    res.json({ id, reloaded: true });
  });

  /**
   * Uninstall — unregister + rm -rf the crew dir. Strict path check
   * ensures the dir is inside crewLoader.rootDir so a malicious id like
   * `../../etc` can't escape.
   */
  app.delete("/api/crew/:id/uninstall", async (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const manifestPath = await findManifestPathForId(deps.crewLoader.rootDir, id);
    if (!manifestPath) throw new NotFoundError(`Crew "${id}" not found on disk.`);
    const crewDir = resolve(manifestPath, "..");
    const root = resolve(deps.crewLoader.rootDir);
    if (crewDir === root || !crewDir.startsWith(root + sep)) {
      // Can't happen via findManifestPathForId, but defense in depth.
      throw new ValidationError(`Refused to remove path outside crew root: ${crewDir}`);
    }

    deps.crews.unregister(id);
    deps.agent.invalidateSystemPromptCache();

    // Drop the persisted disabled flag — the crew no longer exists,
    // a stale entry in the disabled set would leak across re-installs.
    const disabled = readDisabledSet(deps);
    if (disabled.delete(id)) writeDisabledSet(deps, disabled);

    await rm(crewDir, { recursive: true, force: true });
    log.info({ id, crewDir }, "crew uninstalled");
    res.json({ id, uninstalled: true });
  });

  /**
   * Install a crew from npm. Body: { pkg: "daemora-crew-weather" }.
   * Strategy: `npm install <pkg>` into a managed `crew_modules` dir
   * inside the data dir, copy the package contents into `crew/<id>`,
   * then loadOne + register. Idempotent if pkg is already installed.
   */
  app.post("/api/crew/install", async (req: Request, res: Response) => {
    const parsed = installBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const pkg = parsed.data.pkg;

    // Pull the package into a sibling node_modules dir under the data
    // dir. Keeps it out of the user's project node_modules and lets us
    // wipe just this dir on uninstall later.
    const stagingDir = join(deps.cfg.env.dataDir, "crew_modules");
    try {
      await exec(`npm install --prefix "${stagingDir}" --no-save --silent ${JSON.stringify(pkg)}`, {
        timeout: 5 * 60_000,
      });
    } catch (e) {
      throw new ValidationError(`npm install failed: ${(e as Error).message}`);
    }

    // npm normalises to a directory under node_modules/. Resolve its
    // package.json, then look for plugin.json alongside it (the crew
    // package convention).
    const pkgName = pkg.replace(/@[^/@]+$/, ""); // strip version pin
    const pkgRoot = join(stagingDir, "node_modules", pkgName);
    let pkgPlugin: { id?: string } | null = null;
    try {
      pkgPlugin = JSON.parse(await readFile(join(pkgRoot, "plugin.json"), "utf-8")) as { id?: string };
    } catch {
      throw new ValidationError(`Package "${pkg}" has no plugin.json — not a daemora crew.`);
    }
    const id = pkgPlugin.id;
    if (!id || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
      throw new ValidationError(`Invalid crew id in plugin.json: ${String(id)}`);
    }

    // Copy the package contents into <crewRoot>/<id>/. We use cp -R for
    // simplicity; the staging dir is inside our own data dir so we trust
    // its shell-safety. The id was just regex-validated above.
    const targetDir = join(deps.crewLoader.rootDir, id);
    try {
      await exec(`mkdir -p ${JSON.stringify(targetDir)} && cp -R ${JSON.stringify(pkgRoot)}/. ${JSON.stringify(targetDir)}/`);
    } catch (e) {
      throw new ValidationError(`Copy into crew dir failed: ${(e as Error).message}`);
    }

    const fresh = await deps.crewLoader.loadOne(id, deps.agent.tools);
    if (!fresh) throw new ValidationError(`Crew installed but loader couldn't parse the manifest.`);
    deps.crews.register(fresh);
    deps.agent.invalidateSystemPromptCache();

    log.info({ pkg, id }, "crew installed");
    res.json({ id, pkg, installed: true });
  });

  /**
   * GET /api/crew/:id/config — surface the optional `configSchema` from
   * the manifest plus the current values from the vault. Secrets are
   * never returned; the UI gets a 4-char hint instead.
   *
   * The manifest schema we ship doesn't currently formalise configSchema,
   * but plugin.json is hand-edited and may carry a free-form one. We
   * read it directly from the file to support that.
   */
  app.get("/api/crew/:id/config", async (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const manifestPath = await findManifestPathForId(deps.crewLoader.rootDir, id);
    if (!manifestPath) throw new NotFoundError(`Crew "${id}" not found.`);
    let raw: string;
    try { raw = await readFile(manifestPath, "utf-8"); }
    catch { throw new NotFoundError(`Can't read ${manifestPath}.`); }
    let json: { configSchema?: Record<string, { type?: string; label?: string; required?: boolean; default?: string }> };
    try { json = JSON.parse(raw) as typeof json; }
    catch (e) { throw new ValidationError(`plugin.json is malformed: ${(e as Error).message}`); }
    const schema = json.configSchema ?? {};

    const values: Record<string, string> = {};
    for (const key of Object.keys(schema)) {
      const vaultKey = `crew:${id}:${key}`;
      if (deps.cfg.vault.isUnlocked() && deps.cfg.vault.has(vaultKey)) {
        const isSecret = schema[key]?.type === "secret" || schema[key]?.type === "password";
        const entry = deps.cfg.vault.get(vaultKey);
        values[key] = isSecret
          ? `••••${entry?.hint() ?? ""}`
          : (entry?.reveal() ?? "");
      }
    }
    res.json({ id, schema, values });
  });

  /**
   * PUT /api/crew/:id/config — store config values in the vault under
   * `crew:<id>:<key>`. Vault must be unlocked. Empty / undefined values
   * delete the key; setting a value rewrites it.
   */
  app.put("/api/crew/:id/config", async (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const parsed = configBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    if (!deps.cfg.vault.isUnlocked()) {
      return res.status(423).json({ error: "Vault is locked. Unlock before saving crew config." });
    }
    const manifestPath = await findManifestPathForId(deps.crewLoader.rootDir, id);
    if (!manifestPath) throw new NotFoundError(`Crew "${id}" not found.`);

    let updated = 0;
    for (const [key, value] of Object.entries(parsed.data.updates)) {
      const vaultKey = `crew:${id}:${key}`;
      if (!value || value === "") {
        deps.cfg.vault.delete(vaultKey);
      } else {
        deps.cfg.vault.set(vaultKey, value);
      }
      updated++;
    }
    log.info({ id, updated }, "crew config saved");
    res.json({ id, saved: updated });
  });
}

/**
 * Scan the crew root and return the filesystem path of the plugin.json
 * whose `id` matches the requested crew id. Integration-gated crews
 * still have their manifest on disk even when staged out of the
 * registry, so this works for them too.
 */
async function findManifestPathForId(root: string, id: string): Promise<string | null> {
  const absRoot = resolve(root);
  let entries: string[];
  try { entries = await readdir(absRoot); }
  catch { return null; }
  for (const entry of entries) {
    if (entry.startsWith(".") || entry.startsWith("_")) continue;
    const manifestPath = join(absRoot, entry, "plugin.json");
    let raw: string;
    try { raw = await readFile(manifestPath, "utf-8"); }
    catch { continue; }
    try {
      const json = JSON.parse(raw) as { id?: string };
      if (json.id === id) return manifestPath;
    } catch { /* bad JSON — skip */ }
  }
  return null;
}

