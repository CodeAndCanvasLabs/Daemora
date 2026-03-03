/**
 * applyPatch(filePath, patch) - Apply a unified diff patch to a file.
 * Handles multi-hunk edits that editFile's single find-replace can't do.
 * Inspired by OpenClaw's apply_patch tool.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";

/**
 * Parse a unified diff string into an array of hunks.
 * Each hunk: { origStart, origCount, newStart, newCount, lines }
 */
function parseUnifiedDiff(patch) {
  const lines = patch.split("\n");
  const hunks = [];
  let i = 0;

  // Skip file headers (--- +++)
  while (i < lines.length && (lines[i].startsWith("---") || lines[i].startsWith("+++"))) {
    i++;
  }

  while (i < lines.length) {
    const hunkHeader = lines[i].match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (!hunkHeader) { i++; continue; }

    const origStart = parseInt(hunkHeader[1]) - 1; // 0-indexed
    const origCount = hunkHeader[2] !== undefined ? parseInt(hunkHeader[2]) : 1;
    const hunkLines = [];
    i++;

    while (i < lines.length && !lines[i].startsWith("@@")) {
      hunkLines.push(lines[i]);
      i++;
    }

    hunks.push({ origStart, origCount, lines: hunkLines });
  }

  return hunks;
}

/**
 * Apply a single hunk to file lines. Returns new lines array or null on failure.
 * Supports fuzzy matching: tries exact position first, then scans ±10 lines.
 */
function applyHunk(fileLines, hunk, offset) {
  const contextLines = hunk.lines.filter((l) => l.startsWith(" ") || l === "");
  const removals = hunk.lines.filter((l) => l.startsWith("-")).map((l) => l.slice(1));

  const tryAt = (pos) => {
    // Verify context and removals match at this position
    let ri = pos;
    for (const hunkLine of hunk.lines) {
      if (hunkLine.startsWith(" ") || hunkLine === "") {
        // context line - must match
        if (ri >= fileLines.length) return null;
        if (fileLines[ri].trimEnd() !== hunkLine.slice(1).trimEnd()) return null;
        ri++;
      } else if (hunkLine.startsWith("-")) {
        if (ri >= fileLines.length) return null;
        if (fileLines[ri].trimEnd() !== hunkLine.slice(1).trimEnd()) return null;
        ri++;
      }
      // "+" lines don't consume file lines
    }
    return ri; // end position
  };

  // Try intended position first, then fuzzy
  const intendedPos = Math.max(0, hunk.origStart + offset);
  const positions = [intendedPos];
  for (let delta = 1; delta <= 10; delta++) {
    if (intendedPos + delta < fileLines.length) positions.push(intendedPos + delta);
    if (intendedPos - delta >= 0) positions.push(intendedPos - delta);
  }

  for (const pos of positions) {
    const endPos = tryAt(pos);
    if (endPos === null) continue;

    // Build new file lines: everything before hunk + new lines + everything after
    const before = fileLines.slice(0, pos);
    const after = fileLines.slice(endPos);
    const added = hunk.lines
      .filter((l) => l.startsWith("+"))
      .map((l) => l.slice(1));
    const context = hunk.lines
      .filter((l) => l.startsWith(" ") || l === "")
      .map((l) => (l === "" ? "" : l.slice(1)));

    // Reconstruct: before, context+additions interleaved, after
    const middle = [];
    for (const hl of hunk.lines) {
      if (hl.startsWith(" ") || hl === "") middle.push(hl === "" ? "" : hl.slice(1));
      else if (hl.startsWith("+")) middle.push(hl.slice(1));
      // "-" lines are removed, not added
    }

    return { newLines: [...before, ...middle, ...after], newOffset: offset + (endPos - pos) };
  }

  return null;
}

export function applyPatch(filePath, patch) {
  try {
    if (!existsSync(filePath)) {
      return `Error: File not found: ${filePath}`;
    }
    if (!patch || typeof patch !== "string") {
      return "Error: patch must be a unified diff string";
    }

    const content = readFileSync(filePath, "utf-8");
    let fileLines = content.split("\n");
    const hunks = parseUnifiedDiff(patch);

    if (hunks.length === 0) {
      return "Error: No valid hunks found in patch. Ensure it is in unified diff format (with @@ headers).";
    }

    let offset = 0;
    let appliedCount = 0;

    for (let h = 0; h < hunks.length; h++) {
      const result = applyHunk(fileLines, hunks[h], offset);
      if (!result) {
        return `Error: Hunk ${h + 1} of ${hunks.length} failed to apply. Context lines did not match file content. Re-read the file and regenerate the patch.`;
      }
      fileLines = result.newLines;
      offset = result.newOffset;
      appliedCount++;
    }

    writeFileSync(filePath, fileLines.join("\n"), "utf-8");
    return `Applied ${appliedCount} hunk(s) to ${filePath} successfully.`;
  } catch (error) {
    return `Error applying patch: ${error.message}`;
  }
}

export const applyPatchDescription =
  'applyPatch(filePath: string, patch: string) - Apply a unified diff patch to a file. Handles multi-hunk edits. patch must be in standard unified diff format starting with @@ hunk headers.';
