import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";

import type { FilesystemGuard } from "../../safety/FilesystemGuard.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  pattern: z.string().min(1).describe("Glob pattern (e.g. '**/*.ts', 'src/**/*.test.js')."),
  cwd: z.string().default(".").describe("Root directory to search from."),
  maxResults: z.number().int().min(1).max(2000).default(500),
  ignore: z.array(z.string()).default(["node_modules", ".git", "dist", ".next", ".cache", "target", "__pycache__"]),
});

export function makeGlobTool(guard: FilesystemGuard): ToolDef<typeof inputSchema, { files: string[]; count: number; truncated: boolean }> {
  return {
    name: "glob",
    description: "Find files matching a glob pattern. Returns relative paths sorted by modification time.",
    category: "filesystem",
    source: { kind: "core" },
    alwaysOn: true,
    inputSchema,
    async execute({ pattern, cwd, maxResults, ignore }) {
      const root = guard.ensureAllowed(cwd, "read");
      const ignoreSet = new Set(ignore);
      const results: { path: string; mtime: number }[] = [];
      const matcher = globToRegex(pattern);

      async function walk(dir: string): Promise<boolean> {
        if (results.length >= maxResults) return true;
        let entries: string[];
        try { entries = await readdir(dir); } catch { return false; }

        for (const name of entries) {
          if (results.length >= maxResults) return true;
          if (ignoreSet.has(name)) continue;
          const full = join(dir, name);
          let s;
          try { s = await stat(full); } catch { continue; }

          if (s.isDirectory()) {
            if (await walk(full)) return true;
          } else if (s.isFile()) {
            const rel = relative(root, full);
            if (matcher.test(rel)) {
              results.push({ path: rel, mtime: s.mtimeMs });
            }
          }
        }
        return false;
      }

      const truncated = await walk(root);
      results.sort((a, b) => b.mtime - a.mtime);
      return {
        files: results.map((r) => r.path),
        count: results.length,
        truncated,
      };
    },
  };
}

/** Convert a simple glob pattern to a regex. Supports *, **, and ?. */
function globToRegex(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") { re += "(?:.*\\/)?"; i += 3; }
      else { re += ".*"; i += 2; }
    } else if (c === "*") { re += "[^/]*"; i++; }
    else if (c === "?") { re += "[^/]"; i++; }
    else if (c === ".") { re += "\\."; i++; }
    else { re += c; i++; }
  }
  return new RegExp(`^${re}$`);
}
