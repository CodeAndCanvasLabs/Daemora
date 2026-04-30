/**
 * SkillRegistry — in-memory store of loaded skills + matching API.
 *
 * Filtering rules:
 *   - `requires_tools` / `requires_integrations` / `platforms` / `fallback_for_tools`
 *     all participate in the `visible()` pass. A skill is hidden if its
 *     preconditions don't hold (avoids showing the agent a skill it
 *     literally can't act on).
 *
 * System prompt injection:
 *   - `renderIndexForPrompt()` emits the full flat index (hermes pattern):
 *     one line per visible skill with name + description. The model
 *     decides which to load via `skill_view(name)`.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

import type { Skill, SkillLinkedFiles } from "./types.js";

export interface SkillMatch {
  readonly skill: Skill;
  readonly score: number;
}

export interface SkillFilter {
  readonly availableTools: ReadonlySet<string>;
  readonly enabledIntegrations: ReadonlySet<string>;
  /** Current OS platform for filtering (defaults to process.platform). */
  readonly platform?: string;
}

export class SkillRegistry {
  private readonly byId: Map<string, Skill>;

  constructor(skills: readonly Skill[]) {
    this.byId = new Map(skills.map((s) => [s.meta.id, s]));
  }

  get size(): number { return this.byId.size; }

  get(id: string): Skill | undefined { return this.byId.get(id); }

  list(): readonly Skill[] { return Array.from(this.byId.values()); }

  /**
   * Replace the registry contents in place. Preserves the instance
   * identity so anyone holding a reference (crews, tools, system-prompt
   * builder) sees the new set without needing to re-wire.
   */
  replace(skills: readonly Skill[]): void {
    this.byId.clear();
    for (const s of skills) this.byId.set(s.meta.id, s);
  }

  /** Skills the agent can actually use right now (all requirements met). */
  visible(filter: SkillFilter): readonly Skill[] {
    const platform = (filter.platform ?? process.platform).toLowerCase();
    return this.list().filter((s) => {
      for (const t of s.meta.requires_tools) {
        if (!filter.availableTools.has(t)) return false;
      }
      for (const i of s.meta.requires_integrations) {
        if (!filter.enabledIntegrations.has(i)) return false;
      }
      if (s.meta.platforms.length > 0) {
        const ok = s.meta.platforms.some((p) => platformMatches(platform, p));
        if (!ok) return false;
      }
      // fallback_for_tools: hide this skill if the primary tool IS available
      for (const t of s.meta.fallback_for_tools) {
        if (filter.availableTools.has(t)) return false;
      }
      return true;
    });
  }

  /**
   * Render the flat skill index for the system prompt (hermes pattern).
   *
   * Format:
   *   ## Available Skills
   *   Before replying, scan the skills below. If any matches or is even
   *   partially relevant, you MUST call skill_view(name) and follow it.
   *
   *     - skill-id: description (≤200 chars)
   *
   * Keeps ~80-100 bytes per skill so hundreds of skills fit well within
   * the cached system prompt.
   */
  renderIndexForPrompt(filter: SkillFilter): string {
    const visible = this.visible(filter);
    if (visible.length === 0) return "";

    const sorted = [...visible].sort((a, b) => a.meta.id.localeCompare(b.meta.id));
    const lines: string[] = [
      "## Available Skills",
      "Before replying, scan the skills below. If any matches your task — even partially — " +
        "call `skill_view(name)` first and follow its instructions. " +
        "If you discover a reusable approach not covered, save it with `skill_manage(action=\"create\", ...)`.",
      "",
    ];
    for (const s of sorted) {
      const desc = truncate(s.meta.description, 200);
      lines.push(`  - ${s.meta.id}: ${desc}`);
    }
    return lines.join("\n");
  }

  /**
   * Read a supporting file under a skill's directory. Used by skill_view
   * when the agent requests a specific reference/template/script file.
   * Rejects paths that escape the skill dir.
   */
  async getLinkedFile(skillId: string, relPath: string): Promise<
    | { kind: "ok"; path: string; content: string }
    | { kind: "err"; reason: string }
  > {
    const skill = this.byId.get(skillId);
    if (!skill) return { kind: "err", reason: `unknown skill: ${skillId}` };

    if (!relPath || isAbsolute(relPath)) {
      return { kind: "err", reason: "file_path must be a relative path" };
    }
    const normalized = normalize(relPath);
    if (normalized.startsWith("..") || normalized.includes("..")) {
      return { kind: "err", reason: "file_path escapes skill directory" };
    }
    const allowedPrefixes = ["references/", "templates/", "scripts/", "assets/"];
    if (!allowedPrefixes.some((p) => normalized.startsWith(p) || normalized.startsWith(p.replace("/", "\\")))) {
      return { kind: "err", reason: "file_path must start with references/, templates/, scripts/, or assets/" };
    }

    const full = join(skill.dir, normalized);
    try {
      const content = await readFile(full, "utf-8");
      return { kind: "ok", path: normalized, content };
    } catch (e) {
      return { kind: "err", reason: `unable to read ${normalized}: ${(e as Error).message}` };
    }
  }

  /** Return linked files for a skill, for skill_view response. */
  linkedFiles(skillId: string): SkillLinkedFiles | null {
    const s = this.byId.get(skillId);
    return s ? s.linkedFiles : null;
  }

  /**
   * Deprecated matcher — kept for tooling that wants to highlight
   * likely-relevant skills in UIs. Not used by the agent system prompt
   * anymore (hermes pattern: agent sees all skills, decides itself).
   *
   * @deprecated Use `renderIndexForPrompt()` instead.
   */
  match(query: string, filter: SkillFilter, limit = 5, minScore = 1): readonly SkillMatch[] {
    const terms = tokenize(query);
    if (terms.size === 0) return [];
    const visible = this.visible(filter);
    const matches: SkillMatch[] = [];
    for (const skill of visible) {
      const haystack = tokenize(
        `${skill.meta.name} ${skill.meta.description} ${skill.meta.triggers.join(" ")}`,
      );
      let score = 0;
      for (const term of terms) { if (haystack.has(term)) score += 1; }
      const triggerHits = skill.meta.triggers.filter((t) => terms.has(t.toLowerCase())).length;
      score += triggerHits * 2;
      if (score >= minScore) matches.push({ skill, score });
    }
    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, limit);
  }
}

const STOPWORDS = new Set([
  "a", "an", "and", "as", "at", "be", "by", "do", "for", "from", "have", "i",
  "in", "is", "it", "of", "on", "or", "the", "to", "with", "you",
]);

function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function truncate(s: string, max: number): string {
  const trimmed = s.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1) + "…";
}

const PLATFORM_ALIAS: Record<string, string> = {
  darwin: "darwin", macos: "darwin", mac: "darwin", osx: "darwin",
  linux: "linux",
  win32: "win32", windows: "win32", win: "win32",
};

function platformMatches(current: string, declared: string): boolean {
  const d = PLATFORM_ALIAS[declared.toLowerCase()] ?? declared.toLowerCase();
  const c = PLATFORM_ALIAS[current.toLowerCase()] ?? current.toLowerCase();
  return c === d || c.startsWith(d);
}
