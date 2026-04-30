/**
 * Skill — a directory holding a SKILL.md file with frontmatter metadata
 * and a body of instructions, plus optional supporting assets.
 *
 * Lazy by design: `Skill` carries only the parsed frontmatter at
 * registry time. The body is read from disk on first match (`loadBody`)
 * to keep startup fast and the system prompt small.
 */

import { z } from "zod";

/** Env-var declaration the skill needs to be operable. */
export const skillEnvVarSchema = z.object({
  name: z.string().min(1).max(128),
  prompt: z.string().max(200).optional(),
  help: z.string().max(500).optional(),
  optional: z.boolean().default(false),
});
export type SkillEnvVar = z.infer<typeof skillEnvVarSchema>;

/** Declarative skill-local config, resolved from settings store at load time. */
export const skillConfigDeclSchema = z.object({
  key: z.string().min(1).max(128),
  description: z.string().max(500).optional(),
  default: z.string().optional(),
  prompt: z.string().max(200).optional(),
});
export type SkillConfigDecl = z.infer<typeof skillConfigDeclSchema>;

/**
 * Schema for the YAML frontmatter at the top of every SKILL.md.
 * Keep this small and stable — adding optional fields is fine,
 * renaming/removing them isn't.
 */
export const skillFrontmatterSchema = z.object({
  /** Stable slug. Set from frontmatter `id` or `name`, or directory name. */
  id: z.string().min(1).default("unknown"),
  /** Human title / slug. JS skills use `name` as the primary key. */
  name: z.string().min(1).max(120),
  /** Summary the agent reads to decide relevance. */
  description: z.string().min(1).max(2000),
  /** Free-form keywords — string (comma-separated) or array. */
  triggers: z.union([
    z.array(z.string()),
    z.string().transform((s) => s.split(/,\s*/).filter(Boolean)),
  ]).default([]),
  /** Tools the skill expects to be available. Skill is hidden if any tool is missing. */
  requires_tools: z.array(z.string()).default([]),
  /** Integrations the skill expects to be enabled. Skill is hidden if any integration is missing. */
  requires_integrations: z.array(z.string()).default([]),
  /** Platforms the skill runs on (e.g. ["darwin", "linux"]). Empty = all. */
  platforms: z.array(z.string()).default([]),
  /** Skill is hidden when any of these primary tools IS available. */
  fallback_for_tools: z.array(z.string()).default([]),
  /** Env vars the skill needs before it's fully operable. */
  required_environment_variables: z.array(skillEnvVarSchema).default([]),
  /** Declarative skill-local config. Resolved from settings. */
  config: z.array(skillConfigDeclSchema).default([]),
  /** Optional version stamp for cache invalidation. */
  version: z.string().default("1.0.0"),
  /** Optional flag to disable a skill without deleting it. */
  enabled: z.boolean().default(true),
});

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

/** Supporting files discovered under a skill directory. */
export interface SkillLinkedFiles {
  readonly references: readonly string[];
  readonly templates: readonly string[];
  readonly scripts: readonly string[];
  readonly assets: readonly string[];
}

export interface Skill {
  /** Resolved frontmatter (validated). */
  readonly meta: SkillFrontmatter;
  /** Absolute path to the skill directory (or the .md file's parent). */
  readonly dir: string;
  /** Absolute path to SKILL.md. */
  readonly file: string;
  /** sha256 of the raw SKILL.md content — for embedding-cache invalidation. */
  readonly contentHash: string;
  /** Linked supporting files under references/, templates/, scripts/, assets/. */
  readonly linkedFiles: SkillLinkedFiles;
  /** Lazy body loader. Reads + caches per-process. */
  loadBody(): Promise<string>;
}

export interface SkillLoadIssue {
  readonly dir: string;
  readonly reason: string;
  readonly cause?: unknown;
}

export interface SkillLoadReport {
  readonly loaded: readonly Skill[];
  readonly skipped: readonly SkillLoadIssue[];
}
