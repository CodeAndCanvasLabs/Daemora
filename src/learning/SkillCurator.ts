/**
 * SkillCurator — the safety net for self-learning skill writes.
 *
 * The BackgroundReviewer can auto-create / auto-patch skills under the
 * tenant's `custom-skills/` tree (NEVER the bundled repo skills, which are
 * hand-authored). Left unchecked, that grows and can rot. The curator:
 *
 *   1. snapshots the custom-skills tree before any mutating pass, so a bad
 *      auto-edit can always be rolled back (Hermes' key discipline);
 *   2. flags stale skills (not touched in `staleDays`) as consolidation /
 *      prune candidates — REPORT ONLY in v1, no destructive auto-delete;
 *   3. writes a structured report and keeps the last N snapshots.
 *
 * v1 deliberately does NOT auto-delete or LLM-consolidate — it builds the
 * reversible substrate first. Destructive consolidation can be layered on
 * later knowing every pass is snapshotted + rollback-able.
 *
 * Only operates on the custom-skills dir. The bundled `skills/` tree is
 * never read or modified here.
 */

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { createLogger } from "../util/logger.js";

const log = createLogger("learning.skillCurator");

const DEFAULT_STALE_DAYS = 90;
const DEFAULT_KEEP_SNAPSHOTS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const WALK_SKIP = new Set([".git", ".github", ".hub", "node_modules", "_template"]);

export interface SkillCuratorOpts {
  /** The custom (auto-learned) skills directory to curate. */
  readonly skillsDir: string;
  /** Where snapshots are written (e.g. <dataDir>/.skill-snapshots). */
  readonly snapshotsDir: string;
  /** Skills untouched for this many days are flagged stale. Default 90. */
  readonly staleDays?: number;
  /** How many snapshots to retain. Default 5. */
  readonly keepSnapshots?: number;
  /** Injectable clock (ms). Default Date.now. Lets tests be deterministic. */
  readonly now?: () => number;
}

export interface StaleSkill {
  readonly name: string;
  readonly path: string;       // relative to skillsDir
  readonly ageDays: number;
}

export interface CuratorReport {
  readonly snapshotId: string | null;
  readonly snapshotPath: string | null;
  readonly scanned: number;
  readonly stale: readonly StaleSkill[];
  readonly ranAt: number;
}

export class SkillCurator {
  private readonly skillsDir: string;
  private readonly snapshotsDir: string;
  private readonly staleDays: number;
  private readonly keepSnapshots: number;
  private readonly now: () => number;

  constructor(opts: SkillCuratorOpts) {
    this.skillsDir = resolve(opts.skillsDir);
    this.snapshotsDir = resolve(opts.snapshotsDir);
    this.staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
    this.keepSnapshots = opts.keepSnapshots ?? DEFAULT_KEEP_SNAPSHOTS;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Full curator pass: snapshot → detect stale → report. Non-destructive.
   * Returns the report; never throws for an empty / missing skills dir.
   */
  async run(): Promise<CuratorReport> {
    const ranAt = this.now();
    if (!existsSync(this.skillsDir)) {
      log.debug({ skillsDir: this.skillsDir }, "no custom-skills dir — curator no-op");
      return { snapshotId: null, snapshotPath: null, scanned: 0, stale: [], ranAt };
    }

    const files = await this.walkSkillFiles();
    if (files.length === 0) {
      return { snapshotId: null, snapshotPath: null, scanned: 0, stale: [], ranAt };
    }

    // Snapshot first — the reversible substrate. If this fails we still
    // report, but flag that no restore-point exists.
    let snapshotId: string | null = null;
    let snapshotPath: string | null = null;
    try {
      const snap = await this.snapshot(ranAt);
      snapshotId = snap.id;
      snapshotPath = snap.path;
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "skill snapshot failed");
    }

    const stale = this.detectStale(files, ranAt);

    const report: CuratorReport = { snapshotId, snapshotPath, scanned: files.length, stale, ranAt };
    await this.writeReport(report);
    await this.pruneSnapshots();
    log.info({ scanned: report.scanned, stale: stale.length, snapshotId }, "skill curator pass complete");
    return report;
  }

  /** Copy the whole custom-skills tree into snapshotsDir/<id>/. */
  async snapshot(at = this.now()): Promise<{ id: string; path: string }> {
    const id = snapshotId(at);
    const dest = join(this.snapshotsDir, id);
    await mkdir(dest, { recursive: true });
    await cp(this.skillsDir, dest, { recursive: true });
    return { id, path: dest };
  }

  /** Snapshot ids, newest first. */
  async listSnapshots(): Promise<string[]> {
    if (!existsSync(this.snapshotsDir)) return [];
    const entries = await readdir(this.snapshotsDir).catch(() => [] as string[]);
    return entries.filter((e) => /^\d{8}T\d{6}Z(?:-\d+)?$/.test(e)).sort().reverse();
  }

  /** Restore the custom-skills tree from a snapshot id. Destructive on skillsDir. */
  async rollback(id: string): Promise<void> {
    const src = join(this.snapshotsDir, id);
    if (!existsSync(src)) throw new Error(`snapshot not found: ${id}`);
    await rm(this.skillsDir, { recursive: true, force: true });
    await mkdir(this.skillsDir, { recursive: true });
    await cp(src, this.skillsDir, { recursive: true });
    log.info({ id }, "skills rolled back from snapshot");
  }

  /** Stale = SKILL-defining file mtime older than staleDays. */
  detectStale(files: readonly { path: string; mtimeMs: number }[], at = this.now()): StaleSkill[] {
    const cutoff = at - this.staleDays * DAY_MS;
    const out: StaleSkill[] = [];
    for (const f of files) {
      if (f.mtimeMs < cutoff) {
        out.push({
          name: skillNameFromPath(f.path),
          path: f.path,
          ageDays: Math.floor((at - f.mtimeMs) / DAY_MS),
        });
      }
    }
    return out.sort((a, b) => b.ageDays - a.ageDays);
  }

  // ── internals ────────────────────────────────────────────────────

  private async walkSkillFiles(): Promise<{ path: string; mtimeMs: number }[]> {
    const out: { path: string; mtimeMs: number }[] = [];
    await this.walk(this.skillsDir, out);
    return out;
  }

  private async walk(dir: string, out: { path: string; mtimeMs: number }[]): Promise<void> {
    let entries: string[];
    try { entries = await readdir(dir); } catch { return; }
    for (const e of entries) {
      if (e.startsWith(".") || e.startsWith("_") || WALK_SKIP.has(e)) continue;
      const full = join(dir, e);
      let s;
      try { s = await stat(full); } catch { continue; }
      if (s.isFile() && (e === "SKILL.md" || e === "skill.md")) {
        out.push({ path: relative(this.skillsDir, full), mtimeMs: s.mtimeMs });
      } else if (s.isDirectory()) {
        await this.walk(full, out);
      }
    }
  }

  private async writeReport(report: CuratorReport): Promise<void> {
    try {
      await mkdir(this.snapshotsDir, { recursive: true });
      const path = join(this.snapshotsDir, "last-report.json");
      await writeFile(path, JSON.stringify(report, null, 2), "utf-8");
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "curator report write failed");
    }
  }

  private async pruneSnapshots(): Promise<void> {
    const snaps = await this.listSnapshots();
    const excess = snaps.slice(this.keepSnapshots);
    for (const id of excess) {
      await rm(join(this.snapshotsDir, id), { recursive: true, force: true }).catch(() => { /* best effort */ });
    }
  }
}

/** UTC compact id: 20260603T044600Z. */
function snapshotId(at: number): string {
  const d = new Date(at);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

/** "category/my-skill/SKILL.md" → "my-skill". */
function skillNameFromPath(relPath: string): string {
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  // drop the trailing file name; the skill name is its parent dir.
  if (parts.length >= 2) return parts[parts.length - 2]!;
  return parts[0] ?? relPath;
}
