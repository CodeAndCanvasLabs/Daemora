/**
 * FileProjectStore — filesystem-backed CRUD for the Files feature.
 *
 * Layout (under `<dataDir>/file-projects/<slug>/`):
 *   project.json   ← manifest (this store reads/writes)
 *   files/...      ← original uploads
 *   filers/...     ← auto-scan sidecars (image descriptions)
 *
 * No DB tables. Listing projects = readdir; reading a project = readFile
 * one JSON. Writes go through a tmp-file rename for crash safety.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";

import type { FileKind, FileProject, FileRecord, ScanStatus } from "./types.js";

const MANIFEST = "project.json";

export class FileProjectStore {
  private readonly root: string;

  constructor(
    dataDir: string,
    private readonly wikiLog?: { append(kind: string, attrs: Record<string, string | number | undefined | null>): void },
  ) {
    this.root = join(dataDir, "file-projects");
    mkdirSync(this.root, { recursive: true });
  }

  /** Absolute path to a project's root directory. */
  pathOf(slug: string): string {
    return join(this.root, slug);
  }

  list(): readonly FileProject[] {
    if (!existsSync(this.root)) return [];
    const out: FileProject[] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const project = this.read(entry.name);
        if (project) out.push(project);
      } catch {
        // Corrupt manifest — skip rather than crash the listing.
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  read(slug: string): FileProject | null {
    const file = join(this.pathOf(slug), MANIFEST);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf-8")) as FileProject;
    } catch {
      return null;
    }
  }

  create(opts: { name: string; color?: string; description?: string }): FileProject {
    const slug = slugify(opts.name);
    if (!slug) throw new Error("Project name must contain at least one alphanumeric character.");
    if (existsSync(this.pathOf(slug))) {
      throw new Error(`A project with slug '${slug}' already exists.`);
    }
    const dir = this.pathOf(slug);
    mkdirSync(join(dir, "files"), { recursive: true });
    mkdirSync(join(dir, "filers"), { recursive: true });
    const now = new Date().toISOString();
    const project: FileProject = {
      id: randomUUID(),
      slug,
      name: opts.name,
      ...(opts.color ? { color: opts.color } : {}),
      ...(opts.description ? { description: opts.description } : {}),
      createdAt: now,
      updatedAt: now,
      files: [],
    };
    this.write(project);
    this.wikiLog?.append("gallery.project.create", {
      slug,
      name: opts.name,
      description: opts.description,
    });
    return project;
  }

  /**
   * Edit project metadata (name / color / description). Slug is the
   * stable identifier so it never changes — rename is name-only.
   */
  updateMeta(slug: string, patch: { name?: string; color?: string; description?: string }): FileProject | null {
    const project = this.read(slug);
    if (!project) return null;
    const updated: FileProject = {
      ...project,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.write(updated);
    this.wikiLog?.append("gallery.project.update", {
      slug,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
    });
    return updated;
  }

  delete(slug: string): boolean {
    const dir = this.pathOf(slug);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    this.wikiLog?.append("gallery.project.delete", { slug });
    return true;
  }

  /**
   * Add a file record to a project. Caller is responsible for placing
   * the bytes at `<projectDir>/<relativePath>` before calling this.
   */
  addFile(slug: string, file: Omit<FileRecord, "id" | "createdAt">): FileRecord {
    const project = this.read(slug);
    if (!project) throw new Error(`Project '${slug}' not found.`);
    const record: FileRecord = {
      id: randomUUID(),
      ...file,
      createdAt: new Date().toISOString(),
    };
    const updated: FileProject = {
      ...project,
      files: [...project.files, record],
      updatedAt: new Date().toISOString(),
    };
    this.write(updated);
    this.wikiLog?.append("gallery.file.add", {
      slug,
      file: record.path,
      kind: record.kind,
    });
    return record;
  }

  removeFile(slug: string, fileId: string): boolean {
    const project = this.read(slug);
    if (!project) return false;
    const file = project.files.find((f) => f.id === fileId);
    if (!file) return false;
    const dir = this.pathOf(slug);
    try { rmSync(join(dir, file.path), { force: true }); } catch { /* already gone */ }
    if (file.filerPath) {
      try { rmSync(join(dir, file.filerPath), { force: true }); } catch { /* already gone */ }
    }
    const updated: FileProject = {
      ...project,
      files: project.files.filter((f) => f.id !== fileId),
      updatedAt: new Date().toISOString(),
    };
    this.write(updated);
    this.wikiLog?.append("gallery.file.remove", { slug, file: file.path });
    return true;
  }

  /** Update a file record in-place (e.g., to flip scanStatus to completed). */
  updateFile(slug: string, fileId: string, patch: Partial<FileRecord>): FileRecord | null {
    const project = this.read(slug);
    if (!project) return null;
    let next: FileRecord | null = null;
    const files = project.files.map((f) => {
      if (f.id !== fileId) return f;
      next = { ...f, ...patch };
      return next;
    });
    if (!next) return null;
    this.write({ ...project, files, updatedAt: new Date().toISOString() });
    return next;
  }

  /** Resolve an absolute path inside a project (for routes / scan workers). */
  resolveAbs(slug: string, relPath: string): string {
    return join(this.pathOf(slug), relPath);
  }

  /** Scan every project for files in pending/scanning state — used at startup. */
  pendingScans(): readonly { slug: string; fileId: string }[] {
    const out: { slug: string; fileId: string }[] = [];
    for (const project of this.list()) {
      for (const file of project.files) {
        if (file.scanStatus === "pending" || file.scanStatus === "scanning") {
          out.push({ slug: project.slug, fileId: file.id });
        }
      }
    }
    return out;
  }

  private write(project: FileProject): void {
    const dir = this.pathOf(project.slug);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, MANIFEST);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(project, null, 2), "utf-8");
    renameSync(tmp, target);
  }
}

/**
 * Slugify a human project name. Lowercases, replaces non-alphanumerics
 * with `-`, collapses runs, trims. Same convention used elsewhere in
 * daemora (browser profiles, etc.).
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** Map a MIME type to our coarse FileKind taxonomy for the manifest. */
export function inferKindFromMime(mimeType: string, filename: string): FileKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("text/")) return "text";
  if (mimeType.includes("officedocument") || mimeType.includes("msword")) return "document";
  const ext = extname(filename).toLowerCase();
  if ([".md", ".txt", ".csv", ".json", ".yaml", ".yml"].includes(ext)) return "text";
  return "other";
}

/** Initial scan status — "pending" only for images, others get "skipped". */
export function initialScanStatus(kind: FileKind): ScanStatus {
  return kind === "image" ? "pending" : "skipped";
}

/** Sanity helper for routes that need to compute size from the on-disk file. */
export function sizeOnDisk(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}
