/**
 * ProfileLoader — discovers profile directories on disk and returns
 * validated, fully-loaded LoadedProfile objects.
 *
 * Lookup order (later wins on id collision):
 *   1. Built-in: `<repo>/profiles/<id>/`
 *   2. Custom:   `<dataDir>/custom-profiles/<id>/`
 *
 * Each profile directory must contain `manifest.json` and `soul.md`.
 * The three include/allowlist files (`crews.json`, `skills.json`,
 * `tools.json`) are optional — omitted means "no restriction".
 *
 * Profiles with malformed manifests are skipped with a warn log; the
 * loader never throws. Worst case: the fallback `daemora` profile
 * stays the only one available and the agent runs unchanged.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger } from "../util/logger.js";
import type { IdInclude, LoadedProfile, ProfileManifest, ToolsConfig } from "./types.js";

const log = createLogger("profiles.loader");

/** Resolve the built-in profiles dir relative to this file's compiled location. */
function builtinDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../profiles");
}

/** Resolve the user-installed profiles dir under the data dir. */
function customDir(dataDir: string): string {
  return join(dataDir, "custom-profiles");
}

export class ProfileLoader {
  constructor(private readonly dataDir: string) {}

  /** Load every profile from both built-in and custom locations. Custom wins on collision. */
  loadAll(): LoadedProfile[] {
    const seen = new Map<string, LoadedProfile>();
    for (const p of this.loadFrom(builtinDir(), "builtin")) seen.set(p.manifest.id, p);
    for (const p of this.loadFrom(customDir(this.dataDir), "custom")) seen.set(p.manifest.id, p);
    return [...seen.values()];
  }

  private loadFrom(root: string, source: "builtin" | "custom"): LoadedProfile[] {
    if (!existsSync(root)) return [];
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch (err) {
      log.warn({ root, err: (err as Error).message }, "profile dir unreadable");
      return [];
    }
    const out: LoadedProfile[] = [];
    for (const name of entries) {
      // Conventional skip — `_shared/` holds runtime.md (loaded by
      // AgentLoop), `_template/` is a scaffold. Underscore prefix = not
      // a profile.
      if (name.startsWith("_") || name.startsWith(".")) continue;
      const dir = join(root, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const loaded = this.loadOne(dir, name, source);
      if (loaded) out.push(loaded);
    }
    return out;
  }

  private loadOne(dir: string, defaultId: string, source: "builtin" | "custom"): LoadedProfile | null {
    const manifestPath = join(dir, "manifest.json");
    const soulPath = join(dir, "soul.md");
    if (!existsSync(manifestPath)) {
      log.warn({ dir }, "profile skipped — manifest.json missing");
      return null;
    }
    if (!existsSync(soulPath)) {
      log.warn({ dir }, "profile skipped — soul.md missing");
      return null;
    }

    let manifest: ProfileManifest;
    try {
      const raw = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        id?: unknown; name?: unknown; nickname?: unknown; description?: unknown; model?: unknown; defaultTier?: unknown;
      };
      const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : defaultId;
      if (typeof raw.name !== "string" || raw.name.length === 0) {
        log.warn({ dir }, "profile skipped — manifest.name missing");
        return null;
      }
      if (typeof raw.description !== "string" || raw.description.length === 0) {
        log.warn({ dir, id }, "profile skipped — manifest.description missing");
        return null;
      }
      manifest = {
        id,
        name: raw.name,
        description: raw.description,
        ...(typeof raw.nickname === "string" ? { nickname: raw.nickname } : {}),
        ...(typeof raw.model === "string" ? { model: raw.model } : {}),
        ...(typeof raw.defaultTier === "string" ? { defaultTier: raw.defaultTier } : {}),
      };
    } catch (err) {
      log.warn({ dir, err: (err as Error).message }, "profile skipped — manifest.json invalid");
      return null;
    }

    let soulPrompt = "";
    try {
      soulPrompt = readFileSync(soulPath, "utf-8").trim();
    } catch (err) {
      log.warn({ dir, err: (err as Error).message }, "profile skipped — soul.md unreadable");
      return null;
    }
    if (!soulPrompt) {
      log.warn({ dir, id: manifest.id }, "profile skipped — soul.md empty");
      return null;
    }

    const crews = readJson<IdInclude>(join(dir, "crews.json"), {});
    const skills = readJson<IdInclude>(join(dir, "skills.json"), {});
    const tools = readJson<ToolsConfig>(join(dir, "tools.json"), {});

    return {
      manifest,
      source,
      soulPath,
      soulPrompt,
      crews,
      skills,
      tools,
    };
  }
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (err) {
    log.warn({ path, err: (err as Error).message }, "profile config invalid — using empty fallback");
    return fallback;
  }
}
