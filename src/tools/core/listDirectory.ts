import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type { FilesystemGuard } from "../../safety/FilesystemGuard.js";
import { NotFoundError, PermissionDeniedError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  path: z.string().min(1).describe("Directory to list"),
  /** Recurse into subdirs (bounded). */
  recursive: z.boolean().default(false),
  /** Cap on entries returned — protects context window. */
  limit: z.number().int().positive().max(2000).default(500),
  /** Skip entries matching any of these names (node_modules, .git, etc.). */
  ignore: z.array(z.string()).default(["node_modules", ".git", "dist", ".next", ".cache", "target"]),
});

interface Entry {
  readonly path: string;
  readonly type: "file" | "dir";
  readonly size?: number;
}

export function makeListDirectoryTool(
  guard: FilesystemGuard,
): ToolDef<typeof inputSchema, { entries: readonly Entry[]; truncated: boolean }> {
  return {
    name: "list_directory",
    description: "List a directory. Recursive optional. Returns up to 500 entries by default; use ignore for noisy folders.",
    category: "filesystem",
    source: { kind: "core" },
    alwaysOn: true,
    inputSchema,
    async execute({ path, recursive, limit, ignore }) {
      const root = guard.ensureAllowed(path, "read");

      try {
        const s = await stat(root);
        if (!s.isDirectory()) throw new ValidationError(`Not a directory: ${root}`);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") throw new NotFoundError(`Directory not found: ${root}`);
        if (err.code === "EACCES") throw new PermissionDeniedError(`Read denied: ${root}`);
        throw e;
      }

      const ignoreSet = new Set(ignore);
      const out: Entry[] = [];

      async function walk(dir: string): Promise<boolean> {
        let names: string[];
        try {
          names = await readdir(dir);
        } catch {
          // Skip unreadable subdirs silently rather than failing the whole walk.
          return false;
        }
        for (const name of names) {
          if (out.length >= limit) return true;
          if (ignoreSet.has(name)) continue;
          const full = join(dir, name);
          // Re-consult the guard for each descendant so a recursive walk
          // can't accidentally cross into a denied subtree via a dir we
          // were allowed to enter.
          try {
            guard.ensureAllowed(full, "read");
          } catch {
            continue;
          }
          let s;
          try {
            s = await stat(full);
          } catch {
            continue;
          }
          if (s.isDirectory()) {
            out.push({ path: full, type: "dir" });
            if (recursive) {
              const truncated = await walk(full);
              if (truncated) return true;
            }
          } else if (s.isFile()) {
            out.push({ path: full, type: "file", size: s.size });
          }
        }
        return false;
      }

      const truncated = await walk(root);
      return { entries: out, truncated };
    },
  };
}
