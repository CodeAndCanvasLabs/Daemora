import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import filesystemGuard from "../safety/FilesystemGuard.js";

export function listDirectory(dirPath = ".") {
  const guard = filesystemGuard.checkRead(dirPath);
  if (!guard.allowed) {
    console.log(`      [listDirectory] BLOCKED: ${guard.reason}`);
    return guard.reason;
  }
  console.log(`      [listDirectory] Listing: ${dirPath}`);
  try {
    const entries = readdirSync(dirPath);
    const results = entries
      .filter((e) => e !== "node_modules" && e !== ".git")
      .map((entry) => {
        try {
          const fullPath = join(dirPath, entry);
          const stat = statSync(fullPath);
          const type = stat.isDirectory() ? "[DIR]" : "[FILE]";
          const size = stat.isFile()
            ? ` (${formatSize(stat.size)})`
            : "";
          return `${type}  ${entry}${size}`;
        } catch {
          return `[?]   ${entry}`;
        }
      });

    console.log(`      [listDirectory] Found ${results.length} entries`);
    return results.length > 0
      ? `Directory: ${dirPath}\n\n${results.join("\n")}`
      : `Directory ${dirPath} is empty.`;
  } catch (error) {
    console.log(`      [listDirectory] Failed: ${error.message}`);
    return `Error listing directory: ${error.message}`;
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export const listDirectoryDescription =
  "listDirectory(dirPath: string) - Lists all files and folders in a directory with their types and sizes. Skips node_modules and .git automatically.";
