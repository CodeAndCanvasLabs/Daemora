/**
 * ProfileRegistry — in-memory store of loaded profiles plus the
 * "which one is active" question.
 *
 * Active id comes from `cfg.settings.getGeneric("DAEMORA_PROFILE")`.
 * Falls back to `daemora` (the built-in default that mirrors the
 * existing SOUL.md content, so installs without a profile setting
 * keep behaving exactly as before).
 *
 * Emits a `change` event when the active profile id changes so the
 * AgentLoop system-prompt cache, channel UI badge, etc. can react.
 */

import { EventEmitter } from "node:events";

import type { ConfigManager } from "../config/ConfigManager.js";
import { createLogger } from "../util/logger.js";
import { ACTIVE_PROFILE_SETTING, DEFAULT_PROFILE_ID, type LoadedProfile } from "./types.js";

const log = createLogger("profiles.registry");

export class ProfileRegistry extends EventEmitter {
  private readonly profiles = new Map<string, LoadedProfile>();
  private currentId: string;

  constructor(profiles: readonly LoadedProfile[], private readonly cfg: ConfigManager) {
    super();
    for (const p of profiles) this.profiles.set(p.manifest.id, p);
    this.currentId = this.resolveActiveId();
    log.info({ profileCount: this.profiles.size, active: this.currentId }, "profile registry initialised");
  }

  /** All loaded profiles, sorted by name. Built-in `daemora` first if present. */
  list(): LoadedProfile[] {
    return [...this.profiles.values()].sort((a, b) => {
      if (a.manifest.id === DEFAULT_PROFILE_ID) return -1;
      if (b.manifest.id === DEFAULT_PROFILE_ID) return 1;
      return a.manifest.name.localeCompare(b.manifest.name);
    });
  }

  /** Get a profile by id. Returns undefined if not loaded. */
  get(id: string): LoadedProfile | undefined {
    return this.profiles.get(id);
  }

  /** Currently-active profile (or the daemora fallback). Always non-null. */
  getActive(): LoadedProfile {
    const p = this.profiles.get(this.currentId);
    if (p) return p;
    // Active id points to a profile we don't have (renamed / removed).
    // Fall back to the default if present; otherwise the first loaded.
    const fallback = this.profiles.get(DEFAULT_PROFILE_ID) ?? this.profiles.values().next().value;
    if (!fallback) {
      throw new Error("ProfileRegistry has no profiles loaded — built-in daemora profile is required");
    }
    log.warn({ requested: this.currentId, served: fallback.manifest.id }, "active profile id not found — falling back");
    return fallback;
  }

  /** Currently-active id (string the setting holds, even if it points at nothing). */
  getActiveId(): string {
    return this.currentId;
  }

  /**
   * Set the active profile. Persists `DAEMORA_PROFILE` and emits `change`.
   * Throws if the id isn't loaded — caller should validate with `get(id)` first.
   */
  setActive(id: string): LoadedProfile {
    const p = this.profiles.get(id);
    if (!p) throw new Error(`Unknown profile: ${id}`);
    if (this.currentId === id) return p;
    this.currentId = id;
    this.cfg.settings.setGeneric(ACTIVE_PROFILE_SETTING, id);
    log.info({ active: id }, "active profile changed");
    this.emit("change", p);
    return p;
  }

  private resolveActiveId(): string {
    const raw = this.cfg.settings.getGeneric(ACTIVE_PROFILE_SETTING);
    if (typeof raw === "string" && raw.length > 0) return raw;
    return DEFAULT_PROFILE_ID;
  }
}
