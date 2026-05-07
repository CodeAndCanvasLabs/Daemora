/**
 * Formatters that turn FileProjectStore data into agent-readable
 * markdown. Used by:
 *   - the `list_gallery_projects` tool (every project, capped)
 *   - CrewAgentRunner auto-inject (selected projects passed via
 *     `references: ["gallery:<slug>"]` on use_crew)
 *
 * Keeps a single source of truth for how a gallery project is
 * presented to the model so both call sites stay in sync.
 */

import { existsSync, readFileSync } from "node:fs";

import type { FileProjectStore } from "./FileProjectStore.js";
import type { FileProject } from "./types.js";

/** Per-project filer-content cap. Big PDFs stay on disk; agent uses read_pdf. */
const MAX_FILER_CHARS_PER_PROJECT = 4_000;
/** Aggregate cap across all projects when listing the entire gallery. */
const MAX_TOTAL_FILER_CHARS = 8_000;

/**
 * Format a single project's manifest — file paths, sizes, and inlined
 * image filers (capped per-project). Returns null if the project
 * doesn't exist on disk.
 */
export function formatGalleryProject(
  store: FileProjectStore,
  slug: string,
  opts: { filerCap?: number } = {},
): string | null {
  const project = store.read(slug);
  if (!project) return null;
  return formatProject(store, project, opts.filerCap ?? MAX_FILER_CHARS_PER_PROJECT);
}

/**
 * Format every gallery project into one markdown block. Inlined image
 * filers are capped in aggregate at MAX_TOTAL_FILER_CHARS so a user
 * with many image-heavy projects doesn't blow up the context window.
 */
export function formatAllGalleryProjects(store: FileProjectStore): string {
  const projects = store.list();
  if (projects.length === 0) {
    return "_No gallery projects yet. The user can create one in the Gallery page (sidebar)._";
  }

  const lines: string[] = [
    `Found ${projects.length} gallery project(s). Each is a curated folder of reference assets the user has dropped in for you to use.`,
    "",
  ];
  let remainingFilerBudget = MAX_TOTAL_FILER_CHARS;
  for (const project of projects) {
    const cap = Math.max(500, Math.min(MAX_FILER_CHARS_PER_PROJECT, remainingFilerBudget));
    const block = formatProject(store, project, cap);
    lines.push(block);
    lines.push("");
    // Rough char-budget accounting on the filer portion. Headers /
    // file lists are negligible; this prevents one project's filers
    // from starving the next one's.
    const filerChars = countFilerChars(store, project, cap);
    remainingFilerBudget = Math.max(0, remainingFilerBudget - filerChars);
  }
  return lines.join("\n");
}

/**
 * Public alias kept for backwards compatibility with the earlier
 * `buildProjectContext` import in TaskRunner. The picker-based
 * auto-inject path was removed in favour of agent tools, but a couple
 * of imports may still reference this name.
 */
export function buildProjectContext({
  store,
  slug,
}: { store: FileProjectStore; slug: string }): string | null {
  return formatGalleryProject(store, slug);
}

function formatProject(store: FileProjectStore, project: FileProject, filerCap: number): string {
  const lines: string[] = [`### ${project.name} (slug: \`${project.slug}\`)`];
  if (project.description && project.description.trim().length > 0) {
    lines.push(`Purpose: ${project.description.trim()}`);
  }
  if (project.files.length === 0) {
    lines.push("_(no files uploaded yet)_");
    return lines.join("\n");
  }

  lines.push("Files:");
  for (const file of project.files) {
    const abs = store.resolveAbs(project.slug, file.path);
    const sizeKb = Math.max(1, Math.round(file.size / 1024));
    const filerNote = file.filerPath ? "; filer below" : "";
    // Filename leads so the agent can refer to "the logo" or "bg.jpg"
    // semantically. Path tail is what `read_file` / `read_pdf` need.
    lines.push(`- **${file.filename}** (${file.kind}, ${sizeKb} KB${filerNote}) — at \`${abs}\``);
  }

  const imagesWithFilers = project.files.filter((f) => f.kind === "image" && f.filerPath);
  if (imagesWithFilers.length > 0) {
    lines.push("");
    lines.push("Image filers:");
    let used = 0;
    for (const file of imagesWithFilers) {
      if (used >= filerCap) {
        lines.push(`(remaining filers truncated; call read_file on the file path above to view)`);
        break;
      }
      const abs = store.resolveAbs(project.slug, file.filerPath!);
      if (!existsSync(abs)) continue;
      let body = "";
      try { body = readFileSync(abs, "utf-8").trim(); } catch { continue; }
      const room = filerCap - used;
      if (body.length > room) {
        body = `${body.slice(0, room)}\n\n…(filer truncated; full content at ${abs})`;
      }
      used += body.length;
      lines.push("");
      lines.push(`#### ${file.filename}`);
      lines.push(body);
    }
  }

  const stillScanning = project.files.filter(
    (f) => f.kind === "image" && (f.scanStatus === "pending" || f.scanStatus === "scanning"),
  );
  if (stillScanning.length > 0) {
    lines.push("");
    lines.push(`_Note: ${stillScanning.length} image(s) still being scanned; their filers aren't ready yet._`);
  }
  return lines.join("\n");
}

function countFilerChars(store: FileProjectStore, project: FileProject, cap: number): number {
  let total = 0;
  for (const file of project.files) {
    if (total >= cap) break;
    if (file.kind !== "image" || !file.filerPath) continue;
    const abs = store.resolveAbs(project.slug, file.filerPath);
    if (!existsSync(abs)) continue;
    try { total += readFileSync(abs, "utf-8").length; } catch { /* skip */ }
  }
  return Math.min(total, cap);
}

/**
 * Parse `references` strings from `use_crew`. Supported scheme today:
 *   "gallery:<slug>"  — load the named gallery project
 * Anything else is ignored (so freeform references like URL strings
 * pass through harmlessly to the crew prompt).
 */
export function extractGallerySlugs(references: readonly string[] | undefined): readonly string[] {
  if (!references) return [];
  const out: string[] = [];
  for (const ref of references) {
    const m = /^\s*gallery:\s*([a-z0-9][a-z0-9-]*)\s*$/i.exec(ref);
    if (m) out.push(m[1]!.toLowerCase());
  }
  return out;
}
