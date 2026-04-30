/**
 * skill_view — pull a skill's full SKILL.md body + supporting files.
 *
 * Pattern (hermes progressive disclosure):
 *   - System prompt shows a flat index of all skills (name + description).
 *   - Agent calls `skill_view(name)` when it judges a skill relevant.
 *   - A second call `skill_view(name, file_path)` loads a specific
 *     supporting file (references/api.md, templates/foo.yaml, etc).
 */

import { z } from "zod";

import type { SkillRegistry } from "../../skills/SkillRegistry.js";
import type { SkillEnvVar, SkillLinkedFiles } from "../../skills/types.js";
import type { ToolDef } from "../types.js";

/** Resolver for declarative skill config values. Falls back to defaults. */
export type SkillConfigResolver = (key: string) => unknown;

const inputSchema = z.object({
  name: z.string().min(1).max(128).describe("Skill id (e.g. 'github', 'coding-agent')."),
  file_path: z.string().max(256).optional().describe(
    "Optional path under the skill dir (e.g. 'references/api.md'). " +
    "Must start with references/, templates/, scripts/, or assets/.",
  ),
});

type SkillViewResult = {
  success: true;
  name: string;
  description: string;
  content: string;
  path: string;
  linked_files: SkillLinkedFiles;
  tags: readonly string[];
  platforms: readonly string[];
  required_environment_variables: readonly SkillEnvVar[];
  resolved_config?: Record<string, unknown>;
  usage_hint: string;
} | {
  success: false;
  error: string;
  available_skills?: readonly string[];
  hint?: string;
};

export function makeSkillViewTool(
  registry: SkillRegistry,
  configResolver?: SkillConfigResolver,
): ToolDef<typeof inputSchema, SkillViewResult> {
  return {
    name: "skill_view",
    description:
      "Load a skill's full instructions. Use after seeing a relevant skill in the Available Skills index. " +
      "Pass file_path to load a specific reference/template/script/asset from the skill.",
    category: "agent",
    source: { kind: "core" },
    alwaysOn: true,
    inputSchema,
    async execute({ name, file_path }) {
      const skill = registry.get(name);
      if (!skill) {
        const ids = registry.list().map((s) => s.meta.id).slice(0, 50);
        return {
          success: false,
          error: `Skill '${name}' not found.`,
          available_skills: ids,
          hint: "Call skill_view with one of the listed skill ids.",
        };
      }

      // Specific supporting-file request
      if (file_path) {
        const res = await registry.getLinkedFile(name, file_path);
        if (res.kind === "err") {
          return { success: false, error: res.reason };
        }
        return {
          success: true,
          name: skill.meta.id,
          description: skill.meta.description,
          content: res.content,
          path: res.path,
          linked_files: skill.linkedFiles,
          tags: skill.meta.triggers,
          platforms: skill.meta.platforms,
          required_environment_variables: skill.meta.required_environment_variables,
          usage_hint: "File loaded. Follow the instructions in the skill body + this file.",
        };
      }

      const body = await skill.loadBody();
      const missingEnv = skill.meta.required_environment_variables
        .filter((e) => !e.optional && !process.env[e.name])
        .map((e) => e.name);

      // Resolve declared config entries from settings, falling back to
      // the skill's declared default. Key lookup pattern: "skills.<id>.<key>"
      // first, then the raw `<key>` as a fallback.
      const resolvedConfig: Record<string, unknown> = {};
      if (skill.meta.config.length > 0) {
        for (const c of skill.meta.config) {
          const scoped = `skills.${skill.meta.id}.${c.key}`;
          const v = configResolver?.(scoped) ?? configResolver?.(c.key);
          resolvedConfig[c.key] = v !== undefined ? v : (c.default ?? null);
        }
      }

      const hintParts = [
        "Follow the instructions in the body.",
        skill.linkedFiles.references.length > 0
          ? `References available: ${skill.linkedFiles.references.join(", ")} — fetch with skill_view(name, file_path).`
          : "",
        skill.linkedFiles.templates.length > 0
          ? `Templates available: ${skill.linkedFiles.templates.join(", ")}.`
          : "",
        skill.linkedFiles.scripts.length > 0
          ? `Scripts available: ${skill.linkedFiles.scripts.join(", ")}.`
          : "",
        missingEnv.length > 0
          ? `Missing env vars required by this skill: ${missingEnv.join(", ")} — ask the user to set them.`
          : "",
      ].filter(Boolean);

      return {
        success: true,
        name: skill.meta.id,
        description: skill.meta.description,
        content: body,
        path: skill.file,
        linked_files: skill.linkedFiles,
        tags: skill.meta.triggers,
        platforms: skill.meta.platforms,
        required_environment_variables: skill.meta.required_environment_variables,
        ...(Object.keys(resolvedConfig).length > 0 ? { resolved_config: resolvedConfig } : {}),
        usage_hint: hintParts.join(" "),
      };
    },
  };
}
