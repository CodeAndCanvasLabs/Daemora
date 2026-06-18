/**
 * Profile primitive — what daemora becomes (specialist behaviour).
 *
 * A profile is a directory with four files:
 *   manifest.json  — id, display name, optional nickname, description
 *   soul.md        — the system prompt the agent runs under
 *   crews.json     — which crews are visible to the agent
 *   skills.json    — which skills are visible to the agent
 *   tools.json     — which tools are callable
 *
 * Profiles ship in `profiles/<id>/` under the repo (built-in). Users can
 * add their own under `<dataDir>/custom-profiles/<id>/`.
 *
 * The active profile is owned by the `DAEMORA_PROFILE` setting. Default
 * is `daemora` — the original generic SOUL.md content. Picking a
 * different profile narrows the crew / skill / tool surface to that
 * specialist's lane without unloading anything.
 */

export interface ProfileManifest {
  /** Stable id — matches the directory name. */
  readonly id: string;
  /** Human-readable name shown in the picker. */
  readonly name: string;
  /** Short tag / vibe word, e.g. "Sage" for the Research profile. Optional. */
  readonly nickname?: string;
  /** One-line description shown alongside the picker option. */
  readonly description: string;
  /** Optional default model override (matches DEFAULT_MODEL shape). */
  readonly model?: string;
  /** Optional default permission tier override ("restricted" | "standard"). */
  readonly defaultTier?: string;
}

/** crews.json / skills.json shape: include-list whitelist (omit/empty → "all"). */
export interface IdInclude {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

/** tools.json shape: tool-name whitelist + category whitelist (intersection). */
export interface ToolsConfig {
  readonly allowedTools?: readonly string[];
  readonly allowedCategories?: readonly string[];
}

/** A loaded profile — manifest + the four resolved configs. */
export interface LoadedProfile {
  readonly manifest: ProfileManifest;
  readonly source: "builtin" | "custom";
  readonly soulPath: string;
  readonly soulPrompt: string;
  readonly crews: IdInclude;
  readonly skills: IdInclude;
  readonly tools: ToolsConfig;
}

/** Setting key the registry watches for the active profile. */
export const ACTIVE_PROFILE_SETTING = "DAEMORA_PROFILE";

/** Fallback profile id when nothing is selected — preserves current behaviour. */
export const DEFAULT_PROFILE_ID = "daemora";
