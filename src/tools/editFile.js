import { readFileSync, writeFileSync } from "node:fs";
import filesystemGuard from "../safety/FilesystemGuard.js";

/**
 * Multi-strategy file editing - inspired by Gemini CLI.
 *
 * Strategy chain:
 * 1. EXACT match - direct string replacement
 * 2. FLEXIBLE match - line-by-line, ignoring leading/trailing whitespace
 * 3. If all fail - show helpful error with nearby context
 */

function exactMatch(content, oldString, newString) {
  if (!content.includes(oldString)) return null;
  const occurrences = content.split(oldString).length - 1;
  const updated = content.replaceAll(oldString, newString);
  return { updated, occurrences, strategy: "exact" };
}

function flexibleMatch(content, oldString, newString) {
  const contentLines = content.split("\n");
  const searchLines = oldString.split("\n").map((l) => l.trim());

  // Find the search block in content, comparing trimmed lines
  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    let match = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (contentLines[i + j].trim() !== searchLines[j]) {
        match = false;
        break;
      }
    }

    if (match) {
      // Preserve the indentation of the first matched line
      const indent = contentLines[i].match(/^(\s*)/)[1];
      const newLines = newString.split("\n").map((line, idx) => {
        if (idx === 0) return indent + line.trimStart();
        return indent + line; // keep relative indentation from newString
      });

      const result = [
        ...contentLines.slice(0, i),
        ...newLines,
        ...contentLines.slice(i + searchLines.length),
      ];

      return { updated: result.join("\n"), occurrences: 1, strategy: "flexible" };
    }
  }
  return null;
}

function findNearbyContext(content, oldString, maxContext = 3) {
  const lines = content.split("\n");
  const searchFirstLine = oldString.split("\n")[0].trim();

  // Find lines similar to the first line of oldString
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().includes(searchFirstLine.slice(0, 30))) {
      const start = Math.max(0, i - maxContext);
      const end = Math.min(lines.length, i + maxContext + 1);
      candidates.push({
        lineNumber: i + 1,
        context: lines
          .slice(start, end)
          .map((l, idx) => `${start + idx + 1} | ${l}`)
          .join("\n"),
      });
    }
  }
  return candidates.slice(0, 3);
}

export function editFile(filePath, oldString, newString) {
  // Parameter validation - model sometimes passes wrong number of args
  if (!filePath || typeof filePath !== "string") {
    return "Error: editFile requires filePath as the first parameter.";
  }
  if (!oldString || typeof oldString !== "string") {
    return "Error: editFile requires oldString as the second parameter - the text to find and replace.";
  }
  if (newString === undefined || newString === null || typeof newString !== "string") {
    return "Error: editFile requires 3 parameters: editFile(filePath, oldString, newString). You only passed 2. oldString is the text to FIND in the file, newString is what to REPLACE it with. If you want to append content, use writeFile instead to rewrite the full file, or use editFile with an existing line as oldString and provide the replacement that includes the new content.";
  }

  // Filesystem security check
  const guard = filesystemGuard.checkWrite(filePath);
  if (!guard.allowed) {
    console.log(`      [editFile] BLOCKED: ${guard.reason}`);
    return guard.reason;
  }

  console.log(`      [editFile] File: ${filePath}`);
  console.log(`      [editFile] Find: "${oldString.slice(0, 60)}${oldString.length > 60 ? "..." : ""}"`);
  console.log(`      [editFile] Replace: "${newString.slice(0, 60)}${newString.length > 60 ? "..." : ""}"`);

  try {
    const content = readFileSync(filePath, { encoding: "utf-8" });

    // Strategy 1: Exact match
    let result = exactMatch(content, oldString, newString);
    if (result) {
      writeFileSync(filePath, result.updated, { encoding: "utf-8" });
      console.log(`      [editFile] Done - ${result.strategy} match, replaced ${result.occurrences} occurrence(s)`);
      return `File ${filePath} edited successfully (${result.strategy} match). Replaced ${result.occurrences} occurrence(s).`;
    }

    // Strategy 2: Flexible match (whitespace-tolerant)
    result = flexibleMatch(content, oldString, newString);
    if (result) {
      writeFileSync(filePath, result.updated, { encoding: "utf-8" });
      console.log(`      [editFile] Done - ${result.strategy} match`);
      return `File ${filePath} edited successfully (${result.strategy} match). Replaced ${result.occurrences} occurrence(s).`;
    }

    // All strategies failed - provide helpful error
    const nearby = findNearbyContext(content, oldString);
    let errorMsg = `Error: Could not find the string to replace in ${filePath}.\n`;
    errorMsg += `Make sure oldString matches the file content (including whitespace/indentation).\n`;

    if (nearby.length > 0) {
      errorMsg += `\nSimilar content found near:\n`;
      for (const c of nearby) {
        errorMsg += `\n--- Line ${c.lineNumber} ---\n${c.context}\n`;
      }
    }

    console.log(`      [editFile] Failed - no match found`);
    return errorMsg;
  } catch (error) {
    console.log(`      [editFile] Failed: ${error.message}`);
    return `Error editing file: ${error.message}`;
  }
}

export const editFileDescription =
  "editFile(filePath: string, oldString: string, newString: string) - Finds oldString in the file and replaces ALL occurrences with newString. Supports exact and flexible matching (whitespace-tolerant). Shows nearby context on failure.";
