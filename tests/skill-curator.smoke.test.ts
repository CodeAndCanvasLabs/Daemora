/**
 * SkillCurator — the self-learning safety net.
 *
 *  - snapshot: makes a restorable copy of the custom-skills tree
 *  - rollback: restores a snapshot (undo a bad auto-edit)
 *  - detectStale: flags skills untouched beyond staleDays
 *  - run: snapshot + report, NON-destructive (no auto-delete in v1)
 *  - prune: retains only the last N snapshots
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SkillCurator } from "../src/learning/SkillCurator.js";

const DAY = 24 * 60 * 60 * 1000;
const FIXED_NOW = Date.UTC(2026, 5, 3, 4, 46, 0); // deterministic clock

async function makeSkill(root: string, name: string, body: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  await writeFile(file, body, "utf-8");
  return file;
}

describe("SkillCurator", () => {
  let base: string;
  let skillsDir: string;
  let snapshotsDir: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "curator-"));
    skillsDir = join(base, "custom-skills");
    snapshotsDir = join(base, ".skill-snapshots");
    await mkdir(skillsDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("snapshot creates a restorable copy of the skills tree", async () => {
    await makeSkill(skillsDir, "alpha", "# alpha");
    const c = new SkillCurator({ skillsDir, snapshotsDir, now: () => FIXED_NOW });
    const { id, path } = await c.snapshot();
    expect(id).toMatch(/^\d{8}T\d{6}Z$/);
    expect(existsSync(join(path, "alpha", "SKILL.md"))).toBe(true);
  });

  it("rollback restores an edited/added tree to the snapshot state", async () => {
    const file = await makeSkill(skillsDir, "alpha", "# original");
    const c = new SkillCurator({ skillsDir, snapshotsDir, now: () => FIXED_NOW });
    const { id } = await c.snapshot();

    // Simulate a bad auto-edit: corrupt alpha + add a junk skill.
    await writeFile(file, "# CORRUPTED", "utf-8");
    await makeSkill(skillsDir, "junk", "# junk");

    await c.rollback(id);

    expect(await readFile(join(skillsDir, "alpha", "SKILL.md"), "utf-8")).toBe("# original");
    expect(existsSync(join(skillsDir, "junk"))).toBe(false);
  });

  it("rollback throws on an unknown snapshot id", async () => {
    const c = new SkillCurator({ skillsDir, snapshotsDir, now: () => FIXED_NOW });
    await expect(c.rollback("nope")).rejects.toThrow(/snapshot not found/);
  });

  it("detectStale flags only skills older than staleDays", () => {
    const c = new SkillCurator({ skillsDir, snapshotsDir, staleDays: 90, now: () => FIXED_NOW });
    const files = [
      { path: join("fresh", "SKILL.md"), mtimeMs: FIXED_NOW - 10 * DAY },
      { path: join("old", "SKILL.md"), mtimeMs: FIXED_NOW - 200 * DAY },
    ];
    const stale = c.detectStale(files);
    expect(stale.map((s) => s.name)).toEqual(["old"]);
    expect(stale[0]!.ageDays).toBe(200);
  });

  it("run() on an empty skills dir is a safe no-op", async () => {
    const c = new SkillCurator({ skillsDir, snapshotsDir, now: () => FIXED_NOW });
    const report = await c.run();
    expect(report.scanned).toBe(0);
    expect(report.snapshotId).toBeNull();
    expect(report.stale).toEqual([]);
  });

  it("run() snapshots + reports stale WITHOUT deleting anything", async () => {
    const fresh = await makeSkill(skillsDir, "fresh", "# fresh");
    const old = await makeSkill(skillsDir, "old", "# old");
    const oldT = new Date(FIXED_NOW - 200 * DAY);
    const freshT = new Date(FIXED_NOW - 5 * DAY);
    await utimes(old, oldT, oldT);
    await utimes(fresh, freshT, freshT);

    const c = new SkillCurator({ skillsDir, snapshotsDir, staleDays: 90, now: () => FIXED_NOW });
    const report = await c.run();

    expect(report.scanned).toBe(2);
    expect(report.snapshotId).not.toBeNull();
    expect(report.stale.map((s) => s.name)).toEqual(["old"]);
    // Non-destructive: both skills still on disk.
    expect(existsSync(join(skillsDir, "old", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsDir, "fresh", "SKILL.md"))).toBe(true);
  });

  it("keeps only the last N snapshots", async () => {
    await makeSkill(skillsDir, "alpha", "# alpha");
    for (let i = 0; i < 4; i++) {
      const cc = new SkillCurator({ skillsDir, snapshotsDir, keepSnapshots: 2, now: () => FIXED_NOW + i * 1000 });
      await cc.snapshot();
    }
    expect((await new SkillCurator({ skillsDir, snapshotsDir }).listSnapshots()).length).toBe(4);

    // A run() adds its own snapshot then prunes to keepSnapshots.
    const c = new SkillCurator({ skillsDir, snapshotsDir, keepSnapshots: 2, now: () => FIXED_NOW + 9000 });
    await c.run();
    expect((await c.listSnapshots()).length).toBe(2);
  });
});
