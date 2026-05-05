/**
 * Smoke tests for the Gallery (Files) feature.
 *
 *  - FileProjectStore CRUD: create, list, addFile, updateFile,
 *    updateMeta, removeFile, delete
 *  - slugify + inferKindFromMime helpers
 *  - formatGalleryProject / formatAllGalleryProjects output structure
 *  - extractGallerySlugs reference parsing
 *  - pendingScans recovery
 *
 * No vision / Vertex calls — the imageFiler module is mocked at the
 * boundary so these tests run fast and offline.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FileProjectStore,
  inferKindFromMime,
  initialScanStatus,
  slugify,
} from "../src/files/FileProjectStore.js";
import {
  buildProjectContext,
  extractGallerySlugs,
  formatAllGalleryProjects,
  formatGalleryProject,
} from "../src/files/projectContext.js";

let dataDir: string;
let store: FileProjectStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "daemora-files-test-"));
  store = new FileProjectStore(dataDir);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("slugify", () => {
  it("lowercases and dasherises", () => {
    expect(slugify("AuditionAid")).toBe("auditionaid");
    expect(slugify("My Brand 2026")).toBe("my-brand-2026");
    expect(slugify("  whitespace  ")).toBe("whitespace");
  });
  it("collapses runs and trims edges", () => {
    expect(slugify("---weird___name///")).toBe("weird-name");
  });
  it("returns empty for non-alphanumeric input", () => {
    expect(slugify("***")).toBe("");
    expect(slugify("")).toBe("");
  });
  it("caps at 64 chars", () => {
    expect(slugify("a".repeat(200))).toHaveLength(64);
  });
});

describe("inferKindFromMime", () => {
  it("classifies common MIME types", () => {
    expect(inferKindFromMime("image/png", "logo.png")).toBe("image");
    expect(inferKindFromMime("image/webp", "x.webp")).toBe("image");
    expect(inferKindFromMime("application/pdf", "x.pdf")).toBe("pdf");
    expect(inferKindFromMime("audio/mpeg", "song.mp3")).toBe("audio");
    expect(inferKindFromMime("video/mp4", "clip.mp4")).toBe("video");
    expect(inferKindFromMime("text/plain", "notes.txt")).toBe("text");
  });
  it("falls back to extension for ambiguous MIMEs", () => {
    expect(inferKindFromMime("application/octet-stream", "notes.md")).toBe("text");
    expect(inferKindFromMime("application/octet-stream", "data.csv")).toBe("text");
    expect(inferKindFromMime("application/octet-stream", "blob.bin")).toBe("other");
  });
  it("recognises office docs", () => {
    expect(inferKindFromMime(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "x.docx",
    )).toBe("document");
  });
});

describe("initialScanStatus", () => {
  it("returns pending only for images", () => {
    expect(initialScanStatus("image")).toBe("pending");
    expect(initialScanStatus("pdf")).toBe("skipped");
    expect(initialScanStatus("audio")).toBe("skipped");
    expect(initialScanStatus("text")).toBe("skipped");
  });
});

describe("FileProjectStore", () => {
  it("creates and reads back a project with description", () => {
    const project = store.create({ name: "AuditionAid", description: "Brand kit." });
    expect(project.slug).toBe("auditionaid");
    expect(project.description).toBe("Brand kit.");
    expect(project.files).toEqual([]);
    const read = store.read("auditionaid");
    expect(read).not.toBeNull();
    expect(read?.id).toBe(project.id);
  });

  it("rejects duplicate slugs", () => {
    store.create({ name: "Foo" });
    expect(() => store.create({ name: "Foo" })).toThrow(/already exists/);
  });

  it("rejects names with no alphanumerics", () => {
    expect(() => store.create({ name: "***" })).toThrow();
  });

  it("lists projects sorted by updatedAt desc", async () => {
    store.create({ name: "Alpha" });
    // Force second project's updatedAt to be later
    await new Promise((r) => setTimeout(r, 10));
    store.create({ name: "Beta" });
    const list = store.list();
    expect(list.map((p) => p.slug)).toEqual(["beta", "alpha"]);
  });

  it("addFile, updateFile, removeFile lifecycle", () => {
    store.create({ name: "Brand" });
    // Place a fake bytes-on-disk so the path resolves.
    const filesDir = store.resolveAbs("brand", "files");
    writeFileSync(join(filesDir, "logo.png"), "PNG");
    const record = store.addFile("brand", {
      kind: "image",
      filename: "logo.png",
      path: "files/logo.png",
      mimeType: "image/png",
      size: 3,
      scanStatus: "pending",
    });
    expect(record.id).toBeTruthy();
    expect(record.scanStatus).toBe("pending");

    const updated = store.updateFile("brand", record.id, {
      scanStatus: "completed",
      filerPath: "filers/logo.png.md",
    });
    expect(updated?.scanStatus).toBe("completed");
    expect(updated?.filerPath).toBe("filers/logo.png.md");

    expect(store.removeFile("brand", record.id)).toBe(true);
    const after = store.read("brand");
    expect(after?.files).toEqual([]);
  });

  it("renames a file via updateFile + filename", () => {
    store.create({ name: "Brand" });
    const filesDir = store.resolveAbs("brand", "files");
    writeFileSync(join(filesDir, "ugly-abc123.png"), "PNG");
    const r = store.addFile("brand", {
      kind: "image",
      filename: "ugly-abc123.png",
      path: "files/ugly-abc123.png",
      mimeType: "image/png",
      size: 3,
    });
    const renamed = store.updateFile("brand", r.id, { filename: "logo.png" });
    expect(renamed?.filename).toBe("logo.png");
    // On-disk path is intentionally unchanged for stability.
    expect(renamed?.path).toBe("files/ugly-abc123.png");
  });

  it("updateMeta edits name / color / description", () => {
    const created = store.create({ name: "Brand" });
    const patched = store.updateMeta("brand", {
      name: "Brand v2",
      color: "#a855f7",
      description: "Updated.",
    });
    expect(patched?.name).toBe("Brand v2");
    expect(patched?.color).toBe("#a855f7");
    expect(patched?.description).toBe("Updated.");
    expect(patched?.id).toBe(created.id);
    expect(patched?.slug).toBe("brand"); // slug stable
  });

  it("delete removes the project directory", () => {
    store.create({ name: "Doomed" });
    expect(store.read("doomed")).not.toBeNull();
    expect(store.delete("doomed")).toBe(true);
    expect(store.read("doomed")).toBeNull();
    expect(store.delete("doomed")).toBe(false); // already gone
  });

  it("pendingScans surfaces image files in pending/scanning state", () => {
    store.create({ name: "Lib" });
    const filesDir = store.resolveAbs("lib", "files");
    writeFileSync(join(filesDir, "a.png"), "X");
    writeFileSync(join(filesDir, "b.png"), "X");
    writeFileSync(join(filesDir, "c.png"), "X");
    const a = store.addFile("lib", { kind: "image", filename: "a.png", path: "files/a.png", mimeType: "image/png", size: 1, scanStatus: "pending" });
    const b = store.addFile("lib", { kind: "image", filename: "b.png", path: "files/b.png", mimeType: "image/png", size: 1, scanStatus: "scanning" });
    store.addFile("lib", { kind: "image", filename: "c.png", path: "files/c.png", mimeType: "image/png", size: 1, scanStatus: "completed" });
    const stuck = store.pendingScans();
    expect(stuck.map((p) => p.fileId).sort()).toEqual([a.id, b.id].sort());
  });
});

describe("formatGalleryProject + buildProjectContext", () => {
  it("returns null for an unknown slug", () => {
    expect(formatGalleryProject(store, "nonexistent")).toBeNull();
    expect(buildProjectContext({ store, slug: "nonexistent" })).toBeNull();
  });

  it("includes name, slug, purpose, file paths, filename-first formatting", () => {
    store.create({ name: "AuditionAid", description: "Brand kit." });
    const filesDir = store.resolveAbs("auditionaid", "files");
    writeFileSync(join(filesDir, "logo-abc.png"), "X");
    store.addFile("auditionaid", {
      kind: "image",
      filename: "logo.png",
      path: "files/logo-abc.png",
      mimeType: "image/png",
      size: 12345,
      scanStatus: "completed",
    });
    const out = formatGalleryProject(store, "auditionaid");
    expect(out).toContain("### AuditionAid");
    expect(out).toContain("slug: `auditionaid`");
    expect(out).toContain("Purpose: Brand kit.");
    // Filename-first formatting: agent reads "logo.png" before the path.
    expect(out).toMatch(/\*\*logo\.png\*\* \(image, 12 KB.*\) — at `.+files\/logo-abc\.png`/);
  });

  it("inlines image filer markdown into the block", () => {
    store.create({ name: "Brand" });
    const filesDir = store.resolveAbs("brand", "files");
    const filersDir = store.resolveAbs("brand", "filers");
    writeFileSync(join(filesDir, "x.png"), "X");
    writeFileSync(
      join(filersDir, "logo.png.md"),
      "---\nkind: logo\n---\n\nA stylised purple star.",
    );
    store.addFile("brand", {
      kind: "image",
      filename: "logo.png",
      path: "files/x.png",
      mimeType: "image/png",
      size: 1,
      scanStatus: "completed",
      filerPath: "filers/logo.png.md",
    });
    const out = formatGalleryProject(store, "brand")!;
    expect(out).toContain("Image filers");
    expect(out).toContain("kind: logo");
    expect(out).toContain("A stylised purple star.");
  });

  it("warns when scans are still pending", () => {
    store.create({ name: "WIP" });
    const filesDir = store.resolveAbs("wip", "files");
    writeFileSync(join(filesDir, "scanning.png"), "X");
    store.addFile("wip", {
      kind: "image",
      filename: "scanning.png",
      path: "files/scanning.png",
      mimeType: "image/png",
      size: 1,
      scanStatus: "scanning",
    });
    const out = formatGalleryProject(store, "wip")!;
    expect(out).toContain("still being scanned");
  });
});

describe("formatAllGalleryProjects", () => {
  it("produces a friendly empty-state when there are no projects", () => {
    expect(formatAllGalleryProjects(store)).toContain("No gallery projects yet");
  });

  it("includes every project with a count header", () => {
    store.create({ name: "Alpha" });
    store.create({ name: "Beta" });
    const out = formatAllGalleryProjects(store);
    expect(out).toContain("Found 2 gallery project");
    expect(out).toContain("### Alpha");
    expect(out).toContain("### Beta");
  });
});

describe("extractGallerySlugs", () => {
  it("parses legacy `gallery:<slug>` strings", () => {
    expect(extractGallerySlugs(["gallery:auditionaid"])).toEqual(["auditionaid"]);
    expect(extractGallerySlugs(["  GALLERY:Brand  "])).toEqual(["brand"]);
  });
  it("ignores non-matching references", () => {
    expect(extractGallerySlugs(["url:https://x.com", "note:hi"])).toEqual([]);
    expect(extractGallerySlugs([])).toEqual([]);
    expect(extractGallerySlugs(undefined)).toEqual([]);
  });
  it("rejects malformed slugs", () => {
    expect(extractGallerySlugs(["gallery:has spaces"])).toEqual([]);
    expect(extractGallerySlugs(["gallery:-leading-dash"])).toEqual([]);
  });
});
