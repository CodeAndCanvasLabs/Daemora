import { readFileSync } from "node:fs";
import filesystemGuard from "../safety/FilesystemGuard.js";

/**
 * Read a file with optional offset and limit (like Claude Code).
 *
 * @param {string} filePath - Path to the file
 * @param {string} [offsetStr] - Line number to start from (1-based), default "1"
 * @param {string} [limitStr] - Max lines to return, default "2000"
 */
export function readFile(filePath, offsetStr, limitStr) {
  const offset = offsetStr ? parseInt(offsetStr, 10) : 1;
  const limit = limitStr ? parseInt(limitStr, 10) : 2000;

  // Filesystem security check
  const guard = filesystemGuard.checkRead(filePath);
  if (!guard.allowed) {
    console.log(`      [readFile] BLOCKED: ${guard.reason}`);
    return guard.reason;
  }

  console.log(`      [readFile] Reading: ${filePath} (offset: ${offset}, limit: ${limit})`);

  try {
    const content = readFileSync(filePath, { encoding: "utf-8" });
    const lines = content.split("\n");
    const totalLines = lines.length;

    // Apply offset (1-based) and limit
    const startIdx = Math.max(0, offset - 1);
    const endIdx = Math.min(totalLines, startIdx + limit);
    const selectedLines = lines.slice(startIdx, endIdx);

    const numbered = selectedLines
      .map((line, i) => `${startIdx + i + 1} | ${line}`)
      .join("\n");

    let result = numbered;
    if (endIdx < totalLines) {
      result += `\n\n[... ${totalLines - endIdx} more lines. Use offset=${endIdx + 1} to continue reading.]`;
    }

    console.log(`      [readFile] Done - showing lines ${startIdx + 1}-${endIdx} of ${totalLines}`);
    return result;
  } catch (error) {
    console.log(`      [readFile] Failed: ${error.message}`);
    return `Error reading file: ${error.message}`;
  }
}

export const readFileDescription =
  "readFile(filePath: string, offset?: string, limit?: string) - Reads a file with line numbers. Optional offset (start line, 1-based) and limit (max lines, default 2000). For large files, read in chunks.";
