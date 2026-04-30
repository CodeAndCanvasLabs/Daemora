/**
 * edit_file — surgical, diff-safe in-place edit.
 *
 * Contract the model can rely on:
 *   - `old_string` must be present EXACTLY once in the file, unless
 *     `replace_all` is true. Zero matches = NotFound. Multiple matches
 *     with replace_all=false = ValidationError with the count. This is
 *     the single most important property — it's what lets an LLM edit
 *     code without rewriting whole files.
 *   - `old_string !== new_string` — we refuse no-op edits.
 *   - Writes via rename-swap (write temp → rename). Crash mid-write
 *     leaves the original intact.
 *   - Records bytes before/after + occurrences replaced so the caller
 *     can surface a meaningful diff summary.
 */

import { readFile, rename, writeFile, stat, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { FilesystemGuard } from "../../safety/FilesystemGuard.js";
import { NotFoundError, PermissionDeniedError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  path: z.string().min(1).describe("Absolute or relative file path. Must already exist."),
  old_string: z.string().min(1).describe("Exact text to replace. Must match once (or use replace_all)."),
  new_string: z.string().describe("Replacement text. Empty = deletion."),
  replace_all: z.boolean().default(false).describe("If true, replace every occurrence."),
});

interface EditResult {
  readonly path: string;
  readonly replacements: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}

export function makeEditFileTool(guard: FilesystemGuard): ToolDef<typeof inputSchema, EditResult> {
  return {
    name: "edit_file",
    description:
      "In-place text replacement. old_string must match exactly once unless replace_all:true. Safer than write_file for modifying existing files.",
    category: "filesystem",
    source: { kind: "core" },
    alwaysOn: true,
    destructive: true,
    inputSchema,
    async execute({ path, old_string, new_string, replace_all }) {
      if (old_string === new_string) {
        throw new ValidationError("edit_file: old_string and new_string are identical — no-op edit rejected.");
      }

      const canonical = guard.ensureAllowed(path, "write");

      let s;
      try {
        s = await stat(canonical);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") throw new NotFoundError(`File not found: ${canonical}`);
        if (err.code === "EACCES") throw new PermissionDeniedError(`Read denied: ${canonical}`);
        throw err;
      }
      if (!s.isFile()) throw new ValidationError(`Not a regular file: ${canonical}`);

      const original = await readFile(canonical, "utf-8");
      const bytesBefore = Buffer.byteLength(original, "utf-8");

      const count = countOccurrences(original, old_string);
      if (count === 0) {
        throw new NotFoundError(
          `edit_file: old_string not found in ${canonical}. File contents may have drifted — re-read before editing.`,
        );
      }
      if (count > 1 && !replace_all) {
        throw new ValidationError(
          `edit_file: old_string appears ${count} times in ${canonical}. Provide a larger unique anchor or pass replace_all:true.`,
        );
      }

      const next = replace_all
        ? original.split(old_string).join(new_string)
        : original.replace(old_string, new_string);
      const bytesAfter = Buffer.byteLength(next, "utf-8");
      const replacements = replace_all ? count : 1;

      // Rename-swap write: crash safety + no torn reads by other procs.
      const tmp = join(dirname(canonical), `.${basename(canonical)}.${randomUUID()}.tmp`);
      try {
        await writeFile(tmp, next, { encoding: "utf-8", mode: s.mode });
        await rename(tmp, canonical);
      } catch (e) {
        try { await unlink(tmp); } catch { /* tmp may not exist; ignore */ }
        const err = e as NodeJS.ErrnoException;
        if (err.code === "EACCES") throw new PermissionDeniedError(`Write denied: ${canonical}`);
        throw err;
      }

      return { path: canonical, replacements, bytesBefore, bytesAfter };
    },
  };
}

/** Count non-overlapping occurrences of needle in haystack. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let idx = 0;
  let n = 0;
  while (true) {
    const hit = haystack.indexOf(needle, idx);
    if (hit < 0) break;
    n++;
    idx = hit + needle.length;
  }
  return n;
}
