/**
 * searchContent(pattern, directory?, optionsJson?) - Search file contents.
 * Upgraded: context lines, case-insensitive, file type filter, extended regex support.
 */
import { execSync } from "node:child_process";
import filesystemGuard from "../safety/FilesystemGuard.js";

function escapeShellArg(str) {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

export function searchContent(params) {
  const pattern = params?.pattern;
  const directory = params?.directory || ".";
  const optionsJson = params?.options;
  // Support old 3-arg API (pattern, directory, limitStr) and new optionsJson
  let opts = {};
  if (optionsJson && !isNaN(parseInt(optionsJson))) {
    opts = { limit: parseInt(optionsJson) };
  } else if (optionsJson) {
    try { opts = JSON.parse(optionsJson); } catch {}
  }

  const limit = opts.limit || 50;
  const caseInsensitive = opts.caseInsensitive || false;
  const contextLines = opts.contextLines ? parseInt(opts.contextLines) : 0;
  const fileType = opts.fileType; // e.g., "js", "ts", "py"
  const useExtendedRegex = opts.regex || false;

  const guard = filesystemGuard.checkRead(directory);
  if (!guard.allowed) {
    console.log(`      [searchContent] BLOCKED: ${guard.reason}`);
    return guard.reason;
  }
  console.log(`      [searchContent] "${pattern}" in ${directory} (limit: ${limit})`);

  try {
    // Build grep command with flags
    let flags = "-rn";
    if (caseInsensitive) flags += "i";
    if (useExtendedRegex) flags += "E";
    if (contextLines > 0) flags += ` -C ${contextLines}`;

    let includeFlag = "";
    if (fileType) {
      includeFlag = `--include=${escapeShellArg(`*.${fileType}`)}`;
    }

    const cmd = [
      `grep ${flags}`,
      escapeShellArg(pattern),
      escapeShellArg(directory),
      "--exclude-dir=node_modules",
      "--exclude-dir=.git",
      "--exclude-dir=dist",
      "--exclude-dir=.next",
      includeFlag,
      "2>/dev/null",
      `| head -${limit}`,
    ].filter(Boolean).join(" ");

    const output = execSync(cmd, { encoding: "utf-8", maxBuffer: 1024 * 1024 });
    const trimmed = output.trim();
    if (!trimmed) {
      return `No matches found for "${pattern}" in ${directory}`;
    }

    const lines = trimmed.split("\n");
    const suffix = lines.length >= limit ? ` (limit: ${limit}, may have more - increase with optionsJson {"limit":200})` : "";
    console.log(`      [searchContent] Found ${lines.length} match(es)`);
    return `Found ${lines.length} match(es) for "${pattern}"${suffix}:\n\n${trimmed}`;
  } catch (error) {
    if (error.status === 1) return `No matches found for "${pattern}" in ${directory}`;
    return `Error searching content: ${error.message}`;
  }
}

export const searchContentDescription =
  'searchContent(pattern: string, directory?: string, optionsJson?: string) - Search file contents with grep. optionsJson: {"limit":50,"caseInsensitive":true,"contextLines":2,"fileType":"js","regex":true}. Returns matching lines with file:line format.';
