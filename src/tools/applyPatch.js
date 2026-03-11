/**
 * applyPatch(filePath, patch) - Apply a diff patch to a file.
 * Handles multi-hunk edits that editFile's single find-replace can't do.
 *
 * Model-agnostic — robust against every common LLM patch format and mistake:
 *
 * Supported formats:
 *   1. Unified diff    — @@ -n,m +n,m @@ with +/- /space-prefixed lines
 *   2. V4A / OpenAI    — *** Begin Patch / *** Update File / bare @@ separators
 *   3. Bare hunks      — @@ separators with +/- lines, no line numbers
 *   4. Simple diff     — n,m c/a/d ranges with < > lines and --- separator
 *   5. Raw +/- blocks  — no headers, just consecutive +/- prefixed lines
 *
 * Resilience features:
 *   - Auto-detects format, falls back through all parsers
 *   - Fuzzy position matching ±100 lines (unified) or full-file scan (no line numbers)
 *   - Whitespace-tolerant comparison (trailing ws, leading indent normalization)
 *   - Handles missing space prefix on context lines (common LLM mistake)
 *   - Handles extra/missing blank lines in patch
 *   - Strips trailing no-newline markers (\ No newline at end of file)
 *   - Falls back to content-based search when position matching fails
 */
import { readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import filesystemGuard from "../safety/FilesystemGuard.js";

// ── Comparison helpers ────────────────────────────────────────────────────────

/** Trim trailing whitespace for comparison */
const trimR = (s) => (s ?? "").trimEnd();

/** Normalize indentation: collapse leading whitespace to single spaces for comparison */
const normIndent = (s) => (s ?? "").replace(/^[\t ]+/, (m) => " ".repeat(m.replace(/\t/g, "    ").length)).trimEnd();

/** Check if two lines match (strict: trailing ws only, loose: indent-normalized) */
function linesMatch(fileLine, patchLine, strict = true) {
  if (trimR(fileLine) === trimR(patchLine)) return true;
  if (!strict && normIndent(fileLine) === normIndent(patchLine)) return true;
  return false;
}

// ── Line classification ──────────────────────────────────────────────────────

/** Determine if a line is metadata (not part of a hunk body) */
function isMetadata(line) {
  return (
    /^\*{3}\s*(Begin|Update|End|Add|Delete)/i.test(line) ||
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    /^---\s+[ab]\//.test(line) ||
    /^\+{3}\s+[ab]\//.test(line) ||
    line.startsWith("--- a/") ||
    line.startsWith("+++ b/") ||
    /^\\ No newline/.test(line)
  );
}

// ── Format detection ──────────────────────────────────────────────────────────

function detectFormat(patch) {
  if (/\*{3}\s*(Begin Patch|Update File|End Patch|Add File|Delete File)/i.test(patch)) return "v4a";
  if (/^@@\s+-\d+/m.test(patch)) return "unified";
  if (/^\d+(?:,\d+)?[acd]\d+/m.test(patch)) return "simple";
  if (/^@@/m.test(patch)) return "bare";
  if (/^[-+][^-+\s]/m.test(patch)) return "raw";
  return "unknown";
}

// ── Parsers ──────────────────────────────────────────────────────────────────

function parseUnifiedDiff(patch) {
  const lines = patch.split("\n");
  const hunks = [];
  let i = 0;

  while (i < lines.length) {
    const hunkHeader = lines[i].match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (!hunkHeader) { i++; continue; }

    const origStart = parseInt(hunkHeader[1]) - 1;
    const hunkLines = [];
    i++;

    while (i < lines.length) {
      const l = lines[i];
      // Stop at next hunk header, diff header, or V4A marker
      if (/^@@/.test(l) || l.startsWith("diff ") || /^\*{3}/.test(l)) break;
      // Skip metadata
      if (isMetadata(l)) { i++; continue; }
      hunkLines.push(l);
      i++;
    }

    // Trim trailing empty non-prefixed lines
    while (hunkLines.length > 0) {
      const last = hunkLines[hunkLines.length - 1];
      if (last === "" || last.trim() === "") hunkLines.pop();
      else break;
    }

    if (hunkLines.length > 0) {
      hunks.push({ origStart, lines: normalizeHunkLines(hunkLines) });
    }
  }

  return hunks;
}

function parseV4A(patch) {
  const lines = patch.split("\n");
  const hunks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isMetadata(line) || /^\*{3}/.test(line) || line.trim() === "") {
      i++;
      continue;
    }

    if (/^@@/.test(line)) {
      const numbered = line.match(/^@@\s+-(\d+)/);
      const origStart = numbered ? parseInt(numbered[1]) - 1 : -1;
      const hunkLines = [];
      i++;

      while (i < lines.length && !/^@@/.test(lines[i]) && !/^\*{3}/.test(lines[i])) {
        if (!isMetadata(lines[i])) {
          hunkLines.push(lines[i]);
        }
        i++;
      }

      // Trim trailing empty lines
      while (hunkLines.length > 0 && hunkLines[hunkLines.length - 1].trim() === "") hunkLines.pop();

      if (hunkLines.length > 0) {
        hunks.push({ origStart, lines: normalizeHunkLines(hunkLines) });
      }
      continue;
    }

    i++;
  }

  return hunks;
}

function parseSimpleDiff(patch) {
  const lines = patch.split("\n");
  const hunks = [];
  let i = 0;

  while (i < lines.length) {
    const rangeMatch = lines[i].match(/^(\d+)(?:,(\d+))?([acd])(\d+)(?:,(\d+))?$/);
    if (!rangeMatch) { i++; continue; }

    const origStart = parseInt(rangeMatch[1]) - 1;
    const hunkLines = [];
    i++;

    while (i < lines.length && !lines[i].match(/^\d+(?:,\d+)?[acd]/)) {
      const l = lines[i];
      if (l.startsWith("< ")) hunkLines.push("-" + l.slice(2));
      else if (l.startsWith("> ")) hunkLines.push("+" + l.slice(2));
      // Skip "---" separator
      i++;
    }

    if (hunkLines.length > 0) {
      hunks.push({ origStart, lines: hunkLines });
    }
  }

  return hunks;
}

function parseRawBlocks(patch) {
  const lines = patch.split("\n");
  const hunks = [];
  let current = [];

  for (const line of lines) {
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
      current.push(line);
    } else {
      if (current.some((l) => l.startsWith("+") || l.startsWith("-"))) {
        hunks.push({ origStart: -1, lines: current });
      }
      current = [];
    }
  }

  if (current.some((l) => l.startsWith("+") || l.startsWith("-"))) {
    hunks.push({ origStart: -1, lines: current });
  }

  return hunks;
}

// ── Hunk line normalization ──────────────────────────────────────────────────
/**
 * Fix common LLM mistakes in hunk lines:
 *   - Lines with no +/-/space prefix that appear between diff lines → infer as context
 *   - "\ No newline at end of file" → strip
 *   - Empty lines between diff lines → treat as context for empty lines
 */
function normalizeHunkLines(lines) {
  const result = [];
  for (const line of lines) {
    // Strip no-newline markers
    if (/^\\ No newline/.test(line)) continue;

    // Already prefixed correctly
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
      result.push(line);
      continue;
    }

    // Empty line — could be context for an empty line in the file
    if (line === "") {
      result.push(" ");
      continue;
    }

    // No prefix — likely a context line where the model forgot the space prefix.
    // Only treat as context if we already have some properly prefixed lines
    // (otherwise it might just be garbage).
    if (result.length > 0 && result.some((r) => r.startsWith("+") || r.startsWith("-"))) {
      result.push(" " + line);
    } else {
      // Before any diff lines: assume context
      result.push(" " + line);
    }
  }
  return result;
}

// ── Hunk application ─────────────────────────────────────────────────────────

const FUZZY_RANGE = 100;

/**
 * Try to match a hunk at a specific file position.
 * Returns the end position in the file if matched, null if not.
 * `strict` controls whitespace comparison mode.
 */
function tryHunkAt(fileLines, hunk, pos, strict) {
  let ri = pos;
  for (const hunkLine of hunk.lines) {
    if (hunkLine.startsWith("+")) continue;

    if (hunkLine.startsWith("-") || hunkLine.startsWith(" ")) {
      if (ri >= fileLines.length) return null;
      if (!linesMatch(fileLines[ri], hunkLine.slice(1), strict)) return null;
      ri++;
    }
  }
  return ri;
}

/**
 * Build the replacement lines from a hunk (context + additions, removals dropped).
 */
function buildMiddle(hunk) {
  const middle = [];
  for (const hl of hunk.lines) {
    if (hl.startsWith(" ")) middle.push(hl.slice(1));
    else if (hl.startsWith("+")) middle.push(hl.slice(1));
    // "-" lines dropped
  }
  return middle;
}

/**
 * Apply a single hunk to file lines.
 *
 * Strategy (in order):
 *   1. Strict match at intended position ± FUZZY_RANGE
 *   2. Loose match (indent-normalized) at intended position ± FUZZY_RANGE
 *   3. Strict match scanning entire file
 *   4. Loose match scanning entire file
 *
 * For hunks with no origStart (V4A/bare): skip steps 1-2, go straight to full scan.
 */
function applyHunk(fileLines, hunk, offset) {
  // Pure additions with no context/removals — append at end
  const hasAnchor = hunk.lines.some((l) => l.startsWith("-") || l.startsWith(" "));
  if (!hasAnchor) {
    const additions = hunk.lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1));
    if (additions.length === 0) return null;
    return { newLines: [...fileLines, ...additions], newOffset: offset };
  }

  const applyAt = (pos, endPos) => {
    const before = fileLines.slice(0, pos);
    const after = fileLines.slice(endPos);
    const middle = buildMiddle(hunk);
    return {
      newLines: [...before, ...middle, ...after],
      newOffset: offset + (middle.length - (endPos - pos)),
    };
  };

  // Build position lists
  const nearPositions = [];
  if (hunk.origStart >= 0) {
    const intended = Math.max(0, hunk.origStart + offset);
    nearPositions.push(intended);
    for (let d = 1; d <= FUZZY_RANGE; d++) {
      if (intended + d < fileLines.length) nearPositions.push(intended + d);
      if (intended - d >= 0) nearPositions.push(intended - d);
    }
  }

  const allPositions = [];
  for (let p = 0; p < fileLines.length; p++) allPositions.push(p);

  const tryList = (positions, strict) => {
    for (const pos of positions) {
      const endPos = tryHunkAt(fileLines, hunk, pos, strict);
      if (endPos !== null) return applyAt(pos, endPos);
    }
    return null;
  };

  // Strategy 1: Strict match near intended position
  if (nearPositions.length > 0) {
    const r = tryList(nearPositions, true);
    if (r) return r;
  }

  // Strategy 2: Loose match near intended position
  if (nearPositions.length > 0) {
    const r = tryList(nearPositions, false);
    if (r) return r;
  }

  // Strategy 3: Strict match full file scan
  { const r = tryList(allPositions, true); if (r) return r; }

  // Strategy 4: Loose match full file scan
  { const r = tryList(allPositions, false); if (r) return r; }

  return null;
}

// ── Main export ──────────────────────────────────────────────────────────────

export function applyPatch(params) {
  const filePath = params?.path || params?.filePath;
  const patch = params?.patch;
  try {
    const readCheck = filesystemGuard.checkRead(filePath);
    if (!readCheck.allowed) return `Error: ${readCheck.reason}`;
    const writeCheck = filesystemGuard.checkWrite(filePath);
    if (!writeCheck.allowed) return `Error: ${writeCheck.reason}`;

    if (!existsSync(filePath)) {
      return `Error: File not found: ${filePath}`;
    }
    if (!patch || typeof patch !== "string") {
      return "Error: patch must be a non-empty string";
    }

    const content = readFileSync(filePath, "utf-8");
    let fileLines = content.split("\n");

    // Detect format and parse
    const format = detectFormat(patch);
    let hunks = [];

    const parserMap = {
      unified: parseUnifiedDiff,
      v4a: parseV4A,
      bare: parseV4A,
      simple: parseSimpleDiff,
      raw: parseRawBlocks,
    };

    // Try detected format first
    if (parserMap[format]) {
      hunks = parserMap[format](patch);
    }

    // If nothing found, cascade through all parsers
    if (hunks.length === 0) {
      for (const parser of [parseUnifiedDiff, parseV4A, parseSimpleDiff, parseRawBlocks]) {
        hunks = parser(patch);
        if (hunks.length > 0) break;
      }
    }

    if (hunks.length === 0) {
      return "Error: Could not parse any hunks from the patch. Use editFile for simple changes, or ensure the patch has +/- prefixed lines with @@ headers.";
    }

    let offset = 0;
    let appliedCount = 0;

    for (let h = 0; h < hunks.length; h++) {
      const result = applyHunk(fileLines, hunks[h], offset);
      if (!result) {
        return `Error: Hunk ${h + 1} of ${hunks.length} failed to apply. Context lines did not match file content. Re-read the file and try editFile instead.`;
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
  'applyPatch(filePath: string, patch: string) - Apply a diff patch to a file. Auto-detects format (unified, V4A, bare @@, simple diff, raw +/- blocks). Fuzzy matching with indent tolerance. For single edits, prefer editFile.';
