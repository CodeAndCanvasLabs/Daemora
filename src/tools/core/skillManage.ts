/**
 * skill_manage — create / edit / patch / delete skills from the agent.
 *
 * This is the write half of hermes-pattern skill learning: when the
 * agent discovers a non-trivial reusable approach, it saves it as a
 * SKILL.md so future turns can reuse it.
 *
 * Safety:
 *   - Atomic writes: temp file + fsync + rename, rollback on security
 *     scan failure.
 *   - Name validation: lowercase / slug / max 64 chars / globally unique.
 *   - Frontmatter validation: must parse + have name + description.
 *   - Security scan on body via SecurityScanner before persist.
 *   - Only operates under the skills root — no escape.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";

import matter from "gray-matter";
import { z } from "zod";

import type { EventBus } from "../../events/eventBus.js";
import { scanContent } from "../../skills/SecurityScanner.js";
import type { SkillRegistry } from "../../skills/SkillRegistry.js";
import type { SkillLoader } from "../../skills/SkillLoader.js";
import { skillFrontmatterSchema } from "../../skills/types.js";
import { createLogger } from "../../util/logger.js";
import type { ToolDef } from "../types.js";

const log = createLogger("tools.skill_manage");

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_CONTENT_CHARS = 100_000;
const MAX_FILE_CHARS = 100_000;
const LINKED_PREFIXES = ["references/", "templates/", "scripts/", "assets/"] as const;

const inputSchema = z.object({
  action: z.enum(["create", "edit", "patch", "delete", "write_file", "remove_file"]),
  name: z.string().min(1).max(64),
  content: z.string().max(MAX_CONTENT_CHARS).optional(),
  category: z.string().max(64).optional(),
  file_path: z.string().max(256).optional(),
  file_content: z.string().max(MAX_FILE_CHARS).optional(),
  old_string: z.string().optional(),
  new_string: z.string().optional(),
  replace_all: z.boolean().default(false),
});

type SkillManageResult =
  | { success: true; message: string; path?: string; hint?: string }
  | { success: false; error: string };

export interface SkillManageDeps {
  readonly registry: SkillRegistry;
  readonly loader: SkillLoader;
  readonly skillsRoot: string;
  readonly bus?: EventBus;
  /** Called after any mutation; the registry should be rebuilt. */
  onChange?: () => Promise<void> | void;
}

export function makeSkillManageTool(
  deps: SkillManageDeps,
): ToolDef<typeof inputSchema, SkillManageResult> {
  return {
    name: "skill_manage",
    description:
      "Create, edit, patch, or delete skills (your procedural memory). " +
      "Use action='create' for a brand-new skill, 'patch' for find/replace edits, " +
      "'edit' for full rewrites, 'delete' to remove. Use 'write_file'/'remove_file' for supporting files " +
      "under references/, templates/, scripts/, or assets/.",
    category: "agent",
    source: { kind: "core" },
    alwaysOn: true,
    destructive: true,
    inputSchema,
    async execute(input) {
      try {
        let result: SkillManageResult;
        switch (input.action) {
          case "create": result = await createSkill(deps, input); break;
          case "edit":   result = await editSkill(deps, input); break;
          case "patch":  result = await patchSkill(deps, input); break;
          case "delete": result = await deleteSkill(deps, input); break;
          case "write_file": result = await writeSkillFile(deps, input); break;
          case "remove_file": result = await removeSkillFile(deps, input); break;
        }
        if (result.success) {
          if (deps.onChange) await deps.onChange();
          if (deps.bus) {
            if (input.action === "create") deps.bus.emit("skill:created", { skillId: input.name, path: result.path ?? "" });
            else if (input.action === "delete") deps.bus.emit("skill:deleted", { skillId: input.name });
            else deps.bus.emit("skill:updated", { skillId: input.name });
          }
        }
        return result;
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    },
  };
}

function validateName(name: string): string | null {
  if (!NAME_RE.test(name)) return `name must match ${NAME_RE} (lowercase, [a-z0-9._-], starts with letter/digit, ≤64 chars)`;
  return null;
}

function resolveSkillDir(root: string, name: string, category?: string): string {
  if (category) {
    const err = validateCategory(category);
    if (err) throw new Error(err);
    return join(root, category, name);
  }
  return join(root, name);
}

function validateCategory(category: string): string | null {
  if (category.includes("..") || category.includes("/") || category.includes("\\")) {
    return "category must be a single directory name (no slashes, no ..)";
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(category)) {
    return "category must match [a-z0-9._-], start with letter/digit, ≤64 chars";
  }
  return null;
}

async function atomicWrite(targetPath: string, content: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const tmp = join(dirname(targetPath), `.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, content, { encoding: "utf-8" });
    await rename(tmp, targetPath);
  } catch (e) {
    try { await unlink(tmp); } catch {}
    throw e;
  }
}

function parseAndValidateFrontmatter(body: string): { ok: true } | { ok: false; error: string } {
  if (!body.startsWith("---")) return { ok: false, error: "content must start with YAML frontmatter (---)" };
  let parsed;
  try { parsed = matter(body); } catch (e) { return { ok: false, error: `frontmatter parse error: ${(e as Error).message}` }; }
  if (!parsed.data || Object.keys(parsed.data).length === 0) {
    return { ok: false, error: "frontmatter missing" };
  }
  const r = skillFrontmatterSchema.safeParse(parsed.data);
  if (!r.success) return { ok: false, error: `invalid frontmatter: ${r.error.message.slice(0, 300)}` };
  if (!parsed.data["name"]) return { ok: false, error: "frontmatter must include `name`" };
  if (!parsed.data["description"]) return { ok: false, error: "frontmatter must include `description`" };
  if (parsed.content.trim().length === 0) return { ok: false, error: "body content must not be empty" };
  return { ok: true };
}

function assertInsideRoot(root: string, target: string): void {
  const r = resolve(root);
  const t = resolve(target);
  const rel = relative(r, t);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("path escapes skills root");
  }
}

async function createSkill(
  deps: SkillManageDeps,
  input: z.infer<typeof inputSchema>,
): Promise<SkillManageResult> {
  if (!input.content) return { success: false, error: "content is required for create" };
  const nameErr = validateName(input.name);
  if (nameErr) return { success: false, error: nameErr };

  // Uniqueness check
  if (deps.registry.get(input.name)) {
    return { success: false, error: `skill '${input.name}' already exists — use action='edit' or 'patch'` };
  }

  const fm = parseAndValidateFrontmatter(input.content);
  if (!fm.ok) return { success: false, error: fm.error };

  const scan = scanContent(input.content);
  if (scan.blocked) return { success: false, error: `security scan rejected content: ${scan.reason}` };

  const skillDir = resolveSkillDir(deps.skillsRoot, input.name, input.category);
  assertInsideRoot(deps.skillsRoot, skillDir);

  try {
    const s = await stat(skillDir);
    if (s.isDirectory()) return { success: false, error: `skill directory already exists: ${skillDir}` };
  } catch { /* good, doesn't exist */ }

  const skillMd = join(skillDir, "SKILL.md");
  try {
    await atomicWrite(skillMd, input.content);
  } catch (e) {
    return { success: false, error: `write failed: ${(e as Error).message}` };
  }

  log.info({ name: input.name, path: skillMd }, "skill created");
  return {
    success: true,
    message: `Skill '${input.name}' created.`,
    path: relative(deps.skillsRoot, skillMd),
    hint: "To add reference files, call skill_manage(action='write_file', name, file_path='references/x.md', file_content=...).",
  };
}

async function editSkill(
  deps: SkillManageDeps,
  input: z.infer<typeof inputSchema>,
): Promise<SkillManageResult> {
  if (!input.content) return { success: false, error: "content is required for edit" };
  const skill = deps.registry.get(input.name);
  if (!skill) return { success: false, error: `skill '${input.name}' not found` };

  const fm = parseAndValidateFrontmatter(input.content);
  if (!fm.ok) return { success: false, error: fm.error };

  const scan = scanContent(input.content);
  if (scan.blocked) return { success: false, error: `security scan rejected content: ${scan.reason}` };

  assertInsideRoot(deps.skillsRoot, skill.file);

  // Backup for rollback
  let backup: string | null = null;
  try { backup = await readFile(skill.file, "utf-8"); } catch {}

  try {
    await atomicWrite(skill.file, input.content);
  } catch (e) {
    if (backup !== null) { try { await atomicWrite(skill.file, backup); } catch {} }
    return { success: false, error: `write failed: ${(e as Error).message}` };
  }

  return {
    success: true,
    message: `Skill '${input.name}' rewritten.`,
    path: relative(deps.skillsRoot, skill.file),
  };
}

async function patchSkill(
  deps: SkillManageDeps,
  input: z.infer<typeof inputSchema>,
): Promise<SkillManageResult> {
  if (input.old_string === undefined || input.new_string === undefined) {
    return { success: false, error: "old_string and new_string are required for patch" };
  }
  const skill = deps.registry.get(input.name);
  if (!skill) return { success: false, error: `skill '${input.name}' not found` };

  const targetPath = input.file_path
    ? join(skill.dir, normalize(input.file_path))
    : skill.file;
  assertInsideRoot(deps.skillsRoot, targetPath);

  let original: string;
  try { original = await readFile(targetPath, "utf-8"); } catch (e) {
    return { success: false, error: `unable to read target: ${(e as Error).message}` };
  }

  if (!original.includes(input.old_string)) {
    return { success: false, error: "old_string not found in target file" };
  }

  const updated = input.replace_all
    ? original.split(input.old_string).join(input.new_string)
    : original.replace(input.old_string, input.new_string);

  // If patching SKILL.md, re-validate + scan
  if (targetPath === skill.file) {
    const fm = parseAndValidateFrontmatter(updated);
    if (!fm.ok) return { success: false, error: fm.error };
  }
  const scan = scanContent(updated);
  if (scan.blocked) return { success: false, error: `security scan rejected content: ${scan.reason}` };

  try {
    await atomicWrite(targetPath, updated);
  } catch (e) {
    return { success: false, error: `write failed: ${(e as Error).message}` };
  }

  return {
    success: true,
    message: `Skill '${input.name}' patched${input.file_path ? ` (${input.file_path})` : ""}.`,
    path: relative(deps.skillsRoot, targetPath),
  };
}

async function deleteSkill(
  deps: SkillManageDeps,
  input: z.infer<typeof inputSchema>,
): Promise<SkillManageResult> {
  const skill = deps.registry.get(input.name);
  if (!skill) return { success: false, error: `skill '${input.name}' not found` };
  assertInsideRoot(deps.skillsRoot, skill.dir);
  try {
    await rm(skill.dir, { recursive: true, force: true });
  } catch (e) {
    return { success: false, error: `delete failed: ${(e as Error).message}` };
  }
  return { success: true, message: `Skill '${input.name}' deleted.` };
}

async function writeSkillFile(
  deps: SkillManageDeps,
  input: z.infer<typeof inputSchema>,
): Promise<SkillManageResult> {
  if (!input.file_path || input.file_content === undefined) {
    return { success: false, error: "file_path and file_content are required" };
  }
  const skill = deps.registry.get(input.name);
  if (!skill) return { success: false, error: `skill '${input.name}' not found` };

  const normalized = normalize(input.file_path);
  if (normalized.startsWith("..") || normalized.includes("..") || isAbsolute(normalized)) {
    return { success: false, error: "file_path must be a relative path inside the skill dir" };
  }
  if (!LINKED_PREFIXES.some((p) => normalized.startsWith(p))) {
    return { success: false, error: `file_path must start with one of: ${LINKED_PREFIXES.join(", ")}` };
  }

  const scan = scanContent(input.file_content);
  if (scan.blocked) return { success: false, error: `security scan rejected content: ${scan.reason}` };

  const full = join(skill.dir, normalized);
  assertInsideRoot(deps.skillsRoot, full);
  try {
    await atomicWrite(full, input.file_content);
  } catch (e) {
    return { success: false, error: `write failed: ${(e as Error).message}` };
  }
  return {
    success: true,
    message: `File '${normalized}' written to skill '${input.name}'.`,
    path: relative(deps.skillsRoot, full),
  };
}

async function removeSkillFile(
  deps: SkillManageDeps,
  input: z.infer<typeof inputSchema>,
): Promise<SkillManageResult> {
  if (!input.file_path) return { success: false, error: "file_path is required" };
  const skill = deps.registry.get(input.name);
  if (!skill) return { success: false, error: `skill '${input.name}' not found` };

  const normalized = normalize(input.file_path);
  if (normalized.startsWith("..") || normalized.includes("..") || isAbsolute(normalized)) {
    return { success: false, error: "file_path must be a relative path inside the skill dir" };
  }
  if (!LINKED_PREFIXES.some((p) => normalized.startsWith(p))) {
    return { success: false, error: `file_path must start with one of: ${LINKED_PREFIXES.join(", ")}` };
  }
  const full = join(skill.dir, normalized);
  assertInsideRoot(deps.skillsRoot, full);
  try {
    await unlink(full);
  } catch (e) {
    return { success: false, error: `delete failed: ${(e as Error).message}` };
  }
  return { success: true, message: `File '${normalized}' removed from skill '${input.name}'.` };
}
