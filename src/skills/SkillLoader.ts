/**
 * SkillLoader — discovers skills from a root directory. Handles:
 *
 *   1. Standalone .md files:  skills/email.md (name from frontmatter)
 *   2. Directories with SKILL.md:  skills/coding-agent/SKILL.md
 *   3. Directories with skill.yaml + *.md: skills/camsnap/skill.yaml
 *   4. Nested category directories: skills/mlops/training/axolotl/SKILL.md
 *
 * Never throws. Bad skills are reported in `skipped`, the rest load.
 *
 * Linked files (references/, templates/, scripts/, assets/) are
 * discovered per-skill and surfaced through Skill.linkedFiles so
 * skill_view can list them without another walk.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import matter from "gray-matter";

import { createLogger } from "../util/logger.js";
import { scanContent } from "./SecurityScanner.js";
import { SkillSnapshot } from "./SkillSnapshot.js";
import type {
  Skill, SkillFrontmatter, SkillLinkedFiles,
  SkillLoadIssue, SkillLoadReport,
} from "./types.js";
import { skillFrontmatterSchema } from "./types.js";

const log = createLogger("skills.loader");

interface BodyCacheEntry { mtimeMs: number; body: string }

/** Directory names skipped when walking for category/skill dirs. */
const WALK_SKIP = new Set([".git", ".github", ".hub", "node_modules", "_template"]);

/** Subdirs scanned for linked files under a skill dir. */
const LINKED_SUBDIRS = ["references", "templates", "scripts", "assets"] as const;

/** File extensions allowed per linked subdir. Empty = any. */
const LINKED_EXTS: Record<(typeof LINKED_SUBDIRS)[number], readonly string[]> = {
  references: [".md", ".txt"],
  templates: [".md", ".yaml", ".yml", ".json", ".py", ".sh", ".tex", ".html"],
  scripts: [".py", ".sh", ".bash", ".js", ".ts", ".rb"],
  assets: [], // any
};

export class SkillLoader {
  private readonly bodyCache = new Map<string, BodyCacheEntry>();
  private readonly snapshot: SkillSnapshot | undefined;

  // Extra roots are optional secondary trees walked alongside the primary
  // skillsRoot. The agent's bundled skills live in `skillsRoot`, while
  // user-created skills (from POST /api/skills/custom) live in a separate
  // tree under the data dir so they survive package upgrades.
  private readonly extraRoots: readonly string[];

  constructor(
    private readonly skillsRoot: string,
    snapshotPath?: string,
    extraRoots: readonly string[] = [],
  ) {
    this.snapshot = snapshotPath ? new SkillSnapshot(skillsRoot, snapshotPath) : undefined;
    this.extraRoots = extraRoots;
  }

  async loadAll(): Promise<SkillLoadReport> {
    const root = resolve(this.skillsRoot);
    const loaded: Skill[] = [];
    const skipped: SkillLoadIssue[] = [];

    await this.walk(root, loaded, skipped);
    for (const extra of this.extraRoots) {
      await this.walk(resolve(extra), loaded, skipped);
    }

    // Persist manifest for next warm start. Snapshot is advisory — we
    // always do the full walk, but the mtime manifest tells us if the
    // tree changed at all (external change detection / future hot-reload).
    if (this.snapshot) {
      try {
        const manifest = await this.snapshot.buildManifest();
        await this.snapshot.writeSnapshot(manifest);
      } catch (e) {
        log.warn({ err: (e as Error).message }, "snapshot write failed (non-fatal)");
      }
    }

    log.info({ loaded: loaded.length, skipped: skipped.length, root }, "skills scan complete");
    return { loaded, skipped };
  }

  /**
   * True iff the on-disk snapshot's manifest matches the live tree.
   * Callers can use this to decide whether to skip a full loadAll.
   * Fast — just mtimes + sizes, no file parsing.
   */
  async isFresh(): Promise<boolean> {
    if (!this.snapshot) return false;
    const prev = await this.snapshot.readSnapshot();
    if (!prev) return false;
    return this.snapshot.isFresh(prev.manifest);
  }

  /**
   * Walk `dir` recursively looking for either:
   *   - Standalone *.md skill files
   *   - Skill dirs containing SKILL.md / skill.md / skill.yaml / README.md
   * When a skill dir is found we do NOT recurse into it (linked files
   * live under that skill, not as separate skills).
   */
  private async walk(dir: string, loaded: Skill[], skipped: SkillLoadIssue[]): Promise<void> {
    let entries: string[];
    try { entries = await readdir(dir); } catch {
      log.warn({ dir }, "skills dir unreadable");
      return;
    }
    entries.sort((a, b) => a.localeCompare(b));

    for (const entry of entries) {
      if (entry.startsWith(".") || entry.startsWith("_")) continue;
      if (WALK_SKIP.has(entry)) continue;
      const full = join(dir, entry);

      let s;
      try { s = await stat(full); } catch { continue; }

      if (s.isFile() && extname(entry) === ".md") {
        const r = await this.loadFromMd(full, entry.replace(/\.md$/, ""));
        if (r.kind === "ok") loaded.push(r.skill);
        else skipped.push(r.issue);
        continue;
      }

      if (!s.isDirectory()) continue;

      // Is this a skill directory?
      if (await this.looksLikeSkillDir(full)) {
        const r = await this.loadFromDir(full);
        if (r.kind === "ok") loaded.push(r.skill);
        else skipped.push(r.issue);
        continue;
      }

      // Otherwise treat as category and recurse.
      await this.walk(full, loaded, skipped);
    }
  }

  private async looksLikeSkillDir(dir: string): Promise<boolean> {
    const dirName = basename(dir);
    const candidates = ["SKILL.md", "skill.md", `${dirName}.md`, "README.md", "skill.yaml"];
    for (const n of candidates) {
      try { const s = await stat(join(dir, n)); if (s.isFile()) return true; } catch { /* next */ }
    }
    return false;
  }

  private async loadFromMd(
    file: string,
    fallbackId: string,
  ): Promise<{ kind: "ok"; skill: Skill } | { kind: "err"; issue: SkillLoadIssue }> {
    let raw: string;
    try { raw = await readFile(file, "utf-8"); } catch (e) {
      return { kind: "err", issue: { dir: file, reason: "unreadable", cause: e } };
    }
    return this.parseSkillFile(raw, file, basename(file, ".md"), fallbackId, {
      references: [], templates: [], scripts: [], assets: [],
    });
  }

  private async loadFromDir(
    dir: string,
  ): Promise<{ kind: "ok"; skill: Skill } | { kind: "err"; issue: SkillLoadIssue }> {
    const dirName = basename(dir);
    const linkedFiles = await this.scanLinkedFiles(dir);

    // Try SKILL.md / skill.md / <dir>.md / README.md
    for (const name of ["SKILL.md", "skill.md", `${dirName}.md`, "README.md"]) {
      const file = join(dir, name);
      try {
        const raw = await readFile(file, "utf-8");
        return this.parseSkillFile(raw, file, dir, dirName, linkedFiles);
      } catch { /* try next */ }
    }

    // Try skill.yaml + first *.md as body
    try {
      const yamlFile = join(dir, "skill.yaml");
      const yamlRaw = await readFile(yamlFile, "utf-8");
      const files = await readdir(dir);
      const mdFile = files.find((f) => f.endsWith(".md"));
      let body = "";
      if (mdFile) {
        try { body = await readFile(join(dir, mdFile), "utf-8"); } catch {}
      }
      const fullRaw = `---\n${yamlRaw}\n---\n${body}`;
      return this.parseSkillFile(fullRaw, yamlFile, dir, dirName, linkedFiles);
    } catch { /* no yaml */ }

    // Fallback: any *.md in dir
    try {
      const files = await readdir(dir);
      const md = files.find((f) => f.endsWith(".md") && !f.startsWith("_"));
      if (md) {
        const file = join(dir, md);
        const raw = await readFile(file, "utf-8");
        return this.parseSkillFile(raw, file, dir, dirName, linkedFiles);
      }
    } catch {}

    return { kind: "err", issue: { dir, reason: "no skill file found" } };
  }

  private async scanLinkedFiles(skillDir: string): Promise<SkillLinkedFiles> {
    const out: Record<(typeof LINKED_SUBDIRS)[number], string[]> = {
      references: [], templates: [], scripts: [], assets: [],
    };
    for (const sub of LINKED_SUBDIRS) {
      const subPath = join(skillDir, sub);
      try {
        const st = await stat(subPath);
        if (!st.isDirectory()) continue;
      } catch { continue; }
      const exts = LINKED_EXTS[sub];
      await this.collectFiles(subPath, sub, exts, out[sub], skillDir);
      out[sub].sort((a, b) => a.localeCompare(b));
    }
    return {
      references: out.references, templates: out.templates,
      scripts: out.scripts, assets: out.assets,
    };
  }

  private async collectFiles(
    dir: string,
    relPrefix: string,
    exts: readonly string[],
    into: string[],
    skillDir: string,
  ): Promise<void> {
    let entries: string[];
    try { entries = await readdir(dir); } catch { return; }
    for (const e of entries) {
      if (e.startsWith(".")) continue;
      const full = join(dir, e);
      let s;
      try { s = await stat(full); } catch { continue; }
      if (s.isFile()) {
        if (exts.length > 0 && !exts.includes(extname(e))) continue;
        into.push(full.slice(skillDir.length + 1));
      } else if (s.isDirectory()) {
        await this.collectFiles(full, `${relPrefix}/${e}`, exts, into, skillDir);
      }
    }
  }

  private parseSkillFile(
    raw: string,
    file: string,
    dir: string,
    fallbackId: string,
    linkedFiles: SkillLinkedFiles,
  ): { kind: "ok"; skill: Skill } | { kind: "err"; issue: SkillLoadIssue } {
    let parsed: { data: Record<string, unknown>; content: string };
    try {
      const m = matter(raw);
      parsed = { data: m.data ?? {}, content: m.content ?? "" };
    } catch (e) {
      return { kind: "err", issue: { dir, reason: "invalid frontmatter", cause: e } };
    }

    if (!parsed.data["id"] && parsed.data["name"]) {
      parsed.data["id"] = String(parsed.data["name"]).toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
    }
    if (!parsed.data["id"]) parsed.data["id"] = fallbackId;
    if (!parsed.data["name"]) parsed.data["name"] = String(parsed.data["id"]);
    if (!parsed.data["description"]) {
      const firstLine = parsed.content.trim().split("\n")[0]?.replace(/^#+\s*/, "").trim();
      parsed.data["description"] = firstLine || String(parsed.data["name"]);
    }

    const validation = skillFrontmatterSchema.safeParse(parsed.data);
    if (!validation.success) {
      return { kind: "err", issue: { dir, reason: `validation: ${validation.error.message.slice(0, 200)}` } };
    }

    const meta: SkillFrontmatter = {
      ...validation.data,
      id: validation.data.id || fallbackId,
    };

    if (!meta.enabled) {
      return { kind: "err", issue: { dir, reason: "disabled" } };
    }

    // Warn on injection patterns but still load — the agent needs to
    // see suspicious content to reason about it. Critical guard is at
    // skill_manage write-time, not load-time.
    const scan = scanContent(parsed.content);
    if (scan.blocked) {
      log.warn({ dir, pattern: scan.pattern }, "skill content matched threat pattern");
    }

    const skill: Skill = {
      meta, dir, file,
      contentHash: sha256(raw),
      linkedFiles,
      loadBody: () => this.readBody(file, parsed.content),
    };
    return { kind: "ok", skill };
  }

  private async readBody(file: string, fallback: string): Promise<string> {
    let mtimeMs: number;
    try { const s = await stat(file); mtimeMs = s.mtimeMs; } catch { return fallback; }

    const cached = this.bodyCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached.body;

    let raw: string;
    try { raw = await readFile(file, "utf-8"); } catch { return fallback; }

    let body: string;
    try { body = matter(raw).content ?? ""; } catch { body = raw; }

    this.bodyCache.set(file, { mtimeMs, body });
    return body;
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
