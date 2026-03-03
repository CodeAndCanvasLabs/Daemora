/**
 * searchFiles(pattern, directory?, optionsJson?) - Find files by name pattern.
 * Upgraded: modification time sorting, depth control, size filters.
 */
import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import filesystemGuard from "../safety/FilesystemGuard.js";

function escapeShellArg(str) {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

export function searchFiles(pattern, directory = ".", optionsJson) {
  let opts = {};
  if (optionsJson) {
    try { opts = JSON.parse(optionsJson); } catch {}
  }

  const sortBy = opts.sortBy; // "modified" | undefined
  const maxDepth = opts.maxDepth ? parseInt(opts.maxDepth) : null;
  const minSize = opts.minSize; // e.g., "+10k"
  const maxSize = opts.maxSize; // e.g., "-1m"

  const guard = filesystemGuard.checkRead(directory);
  if (!guard.allowed) {
    console.log(`      [searchFiles] BLOCKED: ${guard.reason}`);
    return guard.reason;
  }
  console.log(`      [searchFiles] Pattern: "${pattern}" in ${directory}`);

  try {
    const parts = [
      `find ${escapeShellArg(directory)}`,
      `-name ${escapeShellArg(pattern)}`,
      maxDepth ? `-maxdepth ${maxDepth}` : "",
      minSize ? `-size +${minSize}` : "",
      maxSize ? `-size -${maxSize}` : "",
      `-not -path "*/node_modules/*"`,
      `-not -path "*/.git/*"`,
      `-not -path "*/dist/*"`,
      `2>/dev/null`,
    ].filter(Boolean).join(" ");

    const output = execSync(parts, { encoding: "utf-8", maxBuffer: 1024 * 1024 });
    const trimmed = output.trim();
    if (!trimmed) {
      return `No files found matching "${pattern}" in ${directory}`;
    }

    let files = trimmed.split("\n").filter(Boolean);

    // Sort by modification time if requested
    if (sortBy === "modified") {
      files = files
        .map((f) => {
          try {
            return { path: f, mtime: statSync(f).mtimeMs };
          } catch {
            return { path: f, mtime: 0 };
          }
        })
        .sort((a, b) => b.mtime - a.mtime)
        .map((f) => f.path);
    }

    console.log(`      [searchFiles] Found ${files.length} file(s)`);
    return `Found ${files.length} file(s) matching "${pattern}":\n\n${files.join("\n")}`;
  } catch (error) {
    if (!error.stdout?.trim()) return `No files found matching "${pattern}" in ${directory}`;
    return `Error searching files: ${error.message}`;
  }
}

export const searchFilesDescription =
  'searchFiles(pattern: string, directory?: string, optionsJson?: string) - Find files by name (supports wildcards: *.js, *.ts). optionsJson: {"sortBy":"modified","maxDepth":3,"minSize":"10k","maxSize":"1m"}. Skips node_modules/.git/dist.';
