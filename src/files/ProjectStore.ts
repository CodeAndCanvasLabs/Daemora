/**
 * ProjectStore — read-only view over the agent's project workspaces.
 *
 * Projects are the spine of the product (the "sealed workspace" moat). The
 * agent organizes its work under `<dataDir>/projects/<slug>/` with a
 * `.project.json` manifest and type-foldered output (images/ videos/ docs/
 * research/ code/ audio/ + sources/ exports/). This store reads that structure
 * so the UI can list projects and their assets by type.
 */

import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";

const TYPE_DIRS = ["images", "videos", "audio", "docs", "research", "code", "sources", "exports"] as const;

export type AssetKind = "image" | "video" | "audio" | "document" | "code" | "file";

export interface ProjectAsset { kind: AssetKind; filename: string; path: string; size: number; type: string }
/** Project category — drives the agent's working style + the UI badge. */
export type ProjectKind = "general" | "coding" | "research" | "video" | "design" | "writing" | "data";
export const PROJECT_KINDS: readonly ProjectKind[] = ["general", "coding", "research", "video", "design", "writing", "data"];
export interface ProjectSummary { slug: string; name: string; kind: ProjectKind; description?: string; agent?: string; assetCount: number; updatedAt: number }
export interface ProjectDetail extends ProjectSummary { assets: ProjectAsset[] }

// `goal` is the legacy field name (kept for back-compat reads); the current
// field is `description` — NOT related to the removed autonomous Goals feature.
interface Manifest { name?: string; kind?: ProjectKind; description?: string; goal?: string; agent?: string }

/** name → url-safe slug. */
function slugifyName(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return base.length >= 1 ? base : `project-${Date.now().toString(36)}`;
}

/** One node in the VS Code-style project file tree. */
export interface TreeNode {
  name: string;
  /** Absolute path (used by /api/file to render content). */
  path: string;
  /** Path relative to the project root (for display / agent context). */
  rel: string;
  type: "dir" | "file";
  kind?: AssetKind;
  size?: number;
  children?: TreeNode[];
}

const TREE_MAX_DEPTH = 8;
const TREE_MAX_ENTRIES = 4000;

// Build/dependency/cache dirs + junk files that would bury the real source in
// the explorer (and blow the entry budget). Same spirit as a .gitignore.
const TREE_SKIP = new Set([
  ".project.json", ".git", ".hg", ".svn", ".DS_Store",
  "node_modules", ".pnpm-store", ".yarn",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".vite", ".cache", ".vercel", ".netlify",
  ".npm", ".npm-cache", ".tmp", "Library",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv", "venv", ".tox",
  ".gradle", ".idea",
]);

function kindFor(type: string, name: string): AssetKind {
  if (type === "images") return "image";
  if (type === "videos") return "video";
  if (type === "audio") return "audio";
  if (type === "docs" || type === "research") return "document";
  if (type === "code") return "code";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (["mp4", "mov", "webm"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "ogg"].includes(ext)) return "audio";
  if (["md", "txt", "pdf", "doc", "docx"].includes(ext)) return "document";
  return "file";
}

export class ProjectStore {
  private readonly root: string;
  constructor(dataDir: string) { this.root = join(dataDir, "projects"); }

  list(): ProjectSummary[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
      .map((d) => this.summary(d.name))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  detail(slug: string): ProjectDetail | null {
    if (!existsSync(join(this.root, slug))) return null;
    return { ...this.summary(slug), assets: this.assets(slug) };
  }

  /**
   * Full recursive file tree of a project (VS Code-style explorer), confined
   * to `<dataDir>/projects/<slug>/`. Directories first then files, each
   * alphabetical. Skips the `.project.json` manifest (it's metadata, surfaced
   * elsewhere) but shows everything else, including other dotfiles, like an
   * editor would. Bounded by depth + total-entry caps so a pathological tree
   * can't hang the request.
   */
  tree(slug: string): TreeNode[] | null {
    const projectRoot = join(this.root, slug);
    if (!existsSync(projectRoot) || slug.includes("/") || slug.includes("..")) return null;
    const counter = { n: 0 };
    return this.walk(projectRoot, projectRoot, 0, counter);
  }

  private walk(dir: string, projectRoot: string, depth: number, counter: { n: number }): TreeNode[] {
    if (depth > TREE_MAX_DEPTH || counter.n >= TREE_MAX_ENTRIES) return [];
    let entries: import("node:fs").Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const nodes: TreeNode[] = [];
    for (const e of entries) {
      if (counter.n >= TREE_MAX_ENTRIES) break;
      if (TREE_SKIP.has(e.name)) continue;
      counter.n++;
      const abs = join(dir, e.name);
      const rel = abs.slice(projectRoot.length + 1);
      if (e.isDirectory()) {
        nodes.push({ name: e.name, path: abs, rel, type: "dir", children: this.walk(abs, projectRoot, depth + 1, counter) });
      } else if (e.isFile()) {
        let size = 0; try { size = statSync(abs).size; } catch { /* ignore */ }
        nodes.push({ name: e.name, path: abs, rel, type: "file", kind: kindFor("", e.name), size });
      }
    }
    // Directories first, then files; each alphabetical (case-insensitive).
    nodes.sort((a, b) =>
      a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
    return nodes;
  }

  // ── mutations (VS Code-style file management) ────────────────────
  // All paths are resolved + confined under `<projects>/<slug>/`; traversal
  // (`..`, absolute escapes) throws. The agent's FilesystemGuard already pins
  // the tenant to its own dir, but the UI writes here directly so we guard too.

  /** Absolute path for `relPath` inside the project, or throw on escape. */
  private safeAbs(slug: string, relPath: string): string {
    const projectRoot = resolve(this.root, slug);
    if (projectRoot !== join(this.root, slug)) throw new Error("bad project slug");
    const abs = resolve(projectRoot, relPath.replace(/^\/+/, ""));
    if (abs !== projectRoot && !abs.startsWith(projectRoot + sep)) throw new Error("path escapes project");
    return abs;
  }

  /** Write (create or overwrite) a file at `relPath` from raw bytes. */
  writeFile(slug: string, relPath: string, data: Buffer): { rel: string } {
    if (!existsSync(join(this.root, slug))) throw new Error("project not found");
    const abs = this.safeAbs(slug, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
    return { rel: abs.slice(resolve(this.root, slug).length + 1) };
  }

  /** Create an empty file (or directory if `relPath` ends with `/`). Refuses to clobber. */
  createEntry(slug: string, relPath: string): { rel: string } {
    if (!existsSync(join(this.root, slug))) throw new Error("project not found");
    const abs = this.safeAbs(slug, relPath);
    if (existsSync(abs)) throw new Error("already exists");
    if (relPath.endsWith("/")) { mkdirSync(abs, { recursive: true }); }
    else { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, ""); }
    return { rel: abs.slice(resolve(this.root, slug).length + 1) };
  }

  /** Move/rename within the project. */
  move(slug: string, fromRel: string, toRel: string): { rel: string } {
    const from = this.safeAbs(slug, fromRel);
    const to = this.safeAbs(slug, toRel);
    if (!existsSync(from)) throw new Error("source not found");
    if (existsSync(to)) throw new Error("destination already exists");
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    return { rel: to.slice(resolve(this.root, slug).length + 1) };
  }

  /** Delete a file or directory inside the project. */
  remove(slug: string, relPath: string): void {
    const abs = this.safeAbs(slug, relPath);
    if (abs === resolve(this.root, slug)) throw new Error("cannot delete project root");
    rmSync(abs, { recursive: true, force: true });
  }

  private manifest(slug: string): Manifest {
    try { return JSON.parse(readFileSync(join(this.root, slug, ".project.json"), "utf8")); } catch { return {}; }
  }

  private writeManifest(slug: string, m: Manifest): void {
    const dir = join(this.root, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".project.json"), JSON.stringify(m, null, 2));
  }

  private summary(slug: string): ProjectSummary {
    const m = this.manifest(slug);
    let updatedAt = 0;
    try { updatedAt = statSync(join(this.root, slug)).mtimeMs; } catch { /* ignore */ }
    const description = m.description ?? m.goal;   // read legacy `goal`
    return {
      slug,
      name: m.name || slug,
      kind: m.kind && PROJECT_KINDS.includes(m.kind) ? m.kind : "general",
      assetCount: this.assets(slug).length,
      updatedAt,
      ...(description !== undefined ? { description } : {}),
      ...(m.agent !== undefined ? { agent: m.agent } : {}),
    };
  }

  // ── project lifecycle (create / rename / retype / delete) ────────

  /** Create a project from a name + kind (+ optional description). Returns its slug. */
  createProject(input: { name: string; kind?: ProjectKind; description?: string; agent?: string }): ProjectSummary {
    const name = input.name.trim();
    if (!name) throw new Error("name required");
    let slug = slugifyName(name);
    if (existsSync(join(this.root, slug))) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    const kind: ProjectKind = input.kind && PROJECT_KINDS.includes(input.kind) ? input.kind : "general";
    this.writeManifest(slug, {
      name, kind,
      ...(input.description ? { description: input.description } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
    });
    // Skeleton typed dirs so the explorer + asset organization work from turn 0.
    for (const d of ["docs", "research", "code", "images", "videos", "audio"]) mkdirSync(join(this.root, slug, d), { recursive: true });
    return this.summary(slug);
  }

  /** Update a project's manifest (name / kind / description). Slug stays stable. */
  updateProject(slug: string, patch: { name?: string; kind?: ProjectKind; description?: string }): ProjectSummary {
    if (!existsSync(join(this.root, slug))) throw new Error("project not found");
    const m = this.manifest(slug);
    if (patch.name !== undefined) m.name = patch.name.trim() || m.name || slug;
    if (patch.kind !== undefined && PROJECT_KINDS.includes(patch.kind)) m.kind = patch.kind;
    if (patch.description !== undefined) { m.description = patch.description; delete m.goal; }
    this.writeManifest(slug, m);
    return this.summary(slug);
  }

  /** Delete an entire project directory. */
  deleteProject(slug: string): void {
    const dir = resolve(this.root, slug);
    if (dir !== join(this.root, slug) || !dir.startsWith(resolve(this.root) + sep)) throw new Error("bad slug");
    if (!existsSync(dir)) throw new Error("project not found");
    rmSync(dir, { recursive: true, force: true });
  }

  private assets(slug: string): ProjectAsset[] {
    const out: ProjectAsset[] = [];
    for (const type of TYPE_DIRS) {
      const dir = join(this.root, slug, type);
      if (!existsSync(dir)) continue;
      let entries: import("node:fs").Dirent[] = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const f of entries) {
        if (!f.isFile() || f.name.startsWith(".")) continue;
        const p = join(dir, f.name);
        let size = 0; try { size = statSync(p).size; } catch { /* ignore */ }
        out.push({ kind: kindFor(type, f.name), filename: f.name, path: p, size, type });
      }
    }
    return out;
  }
}
