/**
 * glob(pattern, directory?) - Pattern-based file search with modification time sorting.
 * Inspired by Claude Code's Glob tool and Gemini CLI's FindFiles.
 */
import { glob as globFn } from "glob";
import { statSync } from "node:fs";
import { resolve, relative } from "node:path";
import filesystemGuard from "../safety/FilesystemGuard.js";

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

export async function globSearch(params) {
  const pattern = params?.pattern;
  const directory = params?.directory;
  try {
    const dir = directory ? resolve(directory) : process.cwd();

    const guard = filesystemGuard.checkRead(dir);
    if (!guard.allowed) return guard.reason;

    const matches = await globFn(pattern, {
      cwd: dir,
      nodir: true,
      dot: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
      maxDepth: 20,
    });

    if (matches.length === 0) {
      return `No files found matching "${pattern}" in ${dir}`;
    }

    // Stat files and sort: recently modified first, then alphabetical
    const now = Date.now();
    const filesWithStats = matches.map((file) => {
      const fullPath = resolve(dir, file);
      try {
        const stat = statSync(fullPath);
        return { path: file, mtime: stat.mtimeMs, recent: now - stat.mtimeMs < TWENTY_FOUR_HOURS };
      } catch {
        return { path: file, mtime: 0, recent: false };
      }
    });

    // Recent files first (sorted by mtime desc), then rest alphabetically
    filesWithStats.sort((a, b) => {
      if (a.recent && !b.recent) return -1;
      if (!a.recent && b.recent) return 1;
      if (a.recent && b.recent) return b.mtime - a.mtime;
      return a.path.localeCompare(b.path);
    });

    // Cap at 200 results
    const limited = filesWithStats.slice(0, 200);
    const lines = limited.map((f) => f.path);

    let result = `Found ${matches.length} file(s) matching "${pattern}":\n`;
    result += lines.join("\n");
    if (matches.length > 200) {
      result += `\n\n... and ${matches.length - 200} more files (showing first 200)`;
    }
    return result;
  } catch (error) {
    return `Error searching for "${pattern}": ${error.message}`;
  }
}

export const globSearchDescription =
  'globSearch(pattern: string, directory?: string) - Find files matching a glob pattern (e.g., "**/*.js", "src/**/*.ts"). Returns files sorted by modification time (recent first).';
