/**
 * SkillSnapshot — disk-backed manifest cache for skill loading.
 *
 * Hermes pattern: walk the skills tree once, snapshot each SKILL.md's
 * (path, mtime, size) into `data/.skills-snapshot.json`. Next process
 * start, compare the snapshot manifest against the live tree; if every
 * path + mtime + size matches, the in-memory registry is rebuildable
 * from the cached frontmatter without re-parsing file contents.
 *
 * Invalidation: any SKILL.md mtime change anywhere in the tree forces
 * a full rescan — there's no partial update, since category layout can
 * move skills around.
 */

import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { createLogger } from "../util/logger.js";

const log = createLogger("skills.snapshot");

const WALK_SKIP = new Set([".git", ".github", ".hub", "node_modules", "_template"]);

export interface ManifestEntry { readonly path: string; readonly mtimeMs: number; readonly size: number }

export interface SkillSnapshotData {
  readonly version: 1;
  readonly root: string;
  readonly builtAt: number;
  readonly manifest: readonly ManifestEntry[];
}

export class SkillSnapshot {
  constructor(
    private readonly skillsRoot: string,
    private readonly snapshotPath: string,
  ) {}

  /** Walk the tree, collect SKILL.md-equivalent file paths + mtimes. */
  async buildManifest(): Promise<readonly ManifestEntry[]> {
    const entries: ManifestEntry[] = [];
    await this.walk(resolve(this.skillsRoot), entries);
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return entries;
  }

  async readSnapshot(): Promise<SkillSnapshotData | null> {
    try {
      const raw = await readFile(this.snapshotPath, "utf-8");
      const data = JSON.parse(raw) as SkillSnapshotData;
      if (data.version !== 1) return null;
      return data;
    } catch {
      return null;
    }
  }

  async writeSnapshot(manifest: readonly ManifestEntry[]): Promise<void> {
    const data: SkillSnapshotData = {
      version: 1,
      root: resolve(this.skillsRoot),
      builtAt: Date.now(),
      manifest,
    };
    try {
      await mkdir(dirname(this.snapshotPath), { recursive: true });
      await writeFile(this.snapshotPath, JSON.stringify(data), "utf-8");
    } catch (e) {
      log.warn({ err: (e as Error).message }, "snapshot write failed");
    }
  }

  /** True iff every path in `manifest` still matches mtime + size on disk. */
  async isFresh(manifest: readonly ManifestEntry[]): Promise<boolean> {
    // Quick path: count files in tree, must match manifest length.
    const live = await this.buildManifest();
    if (live.length !== manifest.length) return false;
    for (let i = 0; i < live.length; i++) {
      const a = live[i]!; const b = manifest[i]!;
      if (a.path !== b.path || a.mtimeMs !== b.mtimeMs || a.size !== b.size) return false;
    }
    return true;
  }

  private async walk(dir: string, out: ManifestEntry[]): Promise<void> {
    let entries: string[];
    try { entries = await readdir(dir); } catch { return; }
    for (const e of entries) {
      if (e.startsWith(".") || e.startsWith("_")) continue;
      if (WALK_SKIP.has(e)) continue;
      const full = join(dir, e);
      let s;
      try { s = await stat(full); } catch { continue; }
      if (s.isFile() && (e === "SKILL.md" || e === "skill.md" || e === "skill.yaml" || e.endsWith(".md"))) {
        // Only skill-defining files; body/reference files tracked via parent dir
        const rel = relative(resolve(this.skillsRoot), full);
        out.push({ path: rel, mtimeMs: s.mtimeMs, size: s.size });
      } else if (s.isDirectory()) {
        await this.walk(full, out);
      }
    }
  }
}
