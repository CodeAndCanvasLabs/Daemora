/**
 * Files feature — file-only storage (no DB tables).
 *
 * Each project is a directory under `<dataDir>/file-projects/<slug>/`
 * with a single `project.json` manifest plus `files/` (originals) and
 * `filers/` (auto-generated image descriptions). Listing all projects
 * is just readdir + readFile per directory.
 *
 * Directory name uses `file-projects/` (not `projects/`) so it doesn't
 * collide with the agent's task-planning ProjectStore in src/projects/,
 * which is a different concept.
 */

export type FileKind = "image" | "pdf" | "document" | "audio" | "video" | "text" | "other";

export type ScanStatus = "pending" | "scanning" | "completed" | "failed" | "skipped";

export interface FileRecord {
  readonly id: string;
  readonly kind: FileKind;
  readonly filename: string;
  /** Path relative to the project directory, e.g. `files/logo.png`. */
  readonly path: string;
  readonly mimeType: string;
  readonly size: number;
  /** Path relative to the project dir for the auto-scan sidecar (images only). */
  readonly filerPath?: string;
  readonly scanStatus?: ScanStatus;
  readonly scanError?: string;
  readonly createdAt: string;
}

export interface FileProject {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly color?: string;
  /**
   * User-supplied purpose / brief — what this gallery project is FOR.
   * Surfaced to the agent in `list_gallery_projects` output so it knows
   * the intent before reading file contents (e.g. "AuditionAid brand
   * kit — use these assets for any AuditionAid-related work").
   */
  readonly description?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly files: readonly FileRecord[];
}
