/**
 * grep(pattern, optionsJson?) - Advanced content search with context lines.
 * Inspired by Claude Code's Grep tool. Pure Node.js - no shell dependency.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import filesystemGuard from "../safety/FilesystemGuard.js";

const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache"]);

function walkDir(dir, fileType, results = []) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          walkDir(join(dir, entry.name), fileType, results);
        }
      } else if (entry.isFile()) {
        if (!fileType || extname(entry.name) === `.${fileType}` || entry.name.endsWith(`.${fileType}`)) {
          results.push(join(dir, entry.name));
        }
      }
    }
  } catch {}
  return results;
}

export function grep(params) {
  const pattern = params?.pattern;
  const optionsJson = params?.options;
  try {
    const opts = optionsJson ? JSON.parse(optionsJson) : {};
    const {
      directory = process.cwd(),
      contextLines = 0,
      caseInsensitive = false,
      fileType = null,
      outputMode = "content", // "content" | "files_only" | "count"
      limit = 50,
    } = opts;

    const flags = caseInsensitive ? "gi" : "g";
    const regex = new RegExp(pattern, flags);

    const guard = filesystemGuard.checkRead(directory);
    if (!guard.allowed) return guard.reason;

    const files = walkDir(directory, fileType);
    if (files.length === 0) {
      return `No files found to search in ${directory}${fileType ? ` (type: ${fileType})` : ""}`;
    }

    const matchingFiles = [];
    let totalMatches = 0;
    const outputLines = [];

    for (const file of files) {
      let content;
      try {
        content = readFileSync(file, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      const fileMatches = [];

      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          fileMatches.push(i);
          totalMatches++;
        }
      }

      if (fileMatches.length === 0) continue;

      const relPath = relative(process.cwd(), file);
      matchingFiles.push(relPath);

      if (outputMode === "content" && outputLines.length < limit) {
        for (const lineIdx of fileMatches) {
          const start = Math.max(0, lineIdx - contextLines);
          const end = Math.min(lines.length - 1, lineIdx + contextLines);

          for (let j = start; j <= end; j++) {
            const prefix = j === lineIdx ? `${relPath}:${j + 1}:` : `${relPath}-${j + 1}-`;
            outputLines.push(`${prefix}${lines[j]}`);
          }

          if (contextLines > 0 && lineIdx !== fileMatches[fileMatches.length - 1]) {
            outputLines.push("--");
          }
        }
      }
    }

    if (matchingFiles.length === 0) {
      return `No matches found for "${pattern}"`;
    }

    if (outputMode === "files_only") {
      return `Files containing "${pattern}" (${matchingFiles.length}):\n${matchingFiles.join("\n")}`;
    }

    if (outputMode === "count") {
      return `"${pattern}" found ${totalMatches} time(s) in ${matchingFiles.length} file(s)`;
    }

    // content mode
    let result = outputLines.join("\n");
    if (totalMatches > limit) {
      result += `\n\n... showing first ${limit} matches of ${totalMatches} total`;
    }
    return result;
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

export const grepDescription =
  'grep(pattern: string, optionsJson?: string) - Search file contents with regex. optionsJson: {"directory":"./src","contextLines":2,"caseInsensitive":true,"fileType":"js","outputMode":"content|files_only|count","limit":50}';
