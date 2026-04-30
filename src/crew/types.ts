/**
 * Crew — a named specialist sub-agent. The main agent delegates work
 * via `useCrew(crewId, task)`; each crew runs its own AgentLoop with
 * a scoped tool allowlist and persona system prompt.
 *
 * Crew manifests live under `<project>/crew/<id>/plugin.json`. The
 * schema below is the single source of truth — everything else (loader,
 * registry, runner) treats manifests as opaque post-validation.
 */

import { z } from "zod";

export const crewManifestSchema = z.object({
  /** Stable id. Kebab or snake case. Used in useCrew(crewId, …). */
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "id must be kebab/snake-case"),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(2000).describe("Shown to the main agent for delegation decisions."),
  version: z.string().default("1.0.0"),
  profile: z.object({
    systemPrompt: z.string().min(10),
    /** 0-2. Lower = more deterministic. */
    temperature: z.number().min(0).max(2).default(0.3),
    /** Optional model override; falls back to the caller's resolved model. */
    model: z.string().nullable().optional(),
  }),
  /**
   * Tool allowlist. Names must match registered tool names in the
   * ToolRegistry. Names missing from the registry are dropped at load
   * time with a warning — keeps the manifest declarative even as the
   * available-tools set evolves.
   */
  tools: z.array(z.string()).default([]),
  /** Skill IDs this crew specialises in. Empty = inherit all skills. */
  skills: z.array(z.string()).default([]),
  /** Skill IDs explicitly excluded from this crew's context. */
  skillsExclude: z.array(z.string()).default([]),
});

export type CrewManifest = z.infer<typeof crewManifestSchema>;

export interface LoadedCrew {
  readonly manifest: CrewManifest;
  readonly dir: string;
  /** Tool names resolved to the ToolRegistry — always a subset of manifest.tools. */
  readonly resolvedTools: readonly string[];
  /** Names the manifest asked for that didn't exist — logged, not fatal. */
  readonly droppedTools: readonly string[];
}
