import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import filesystemGuard from "../safety/FilesystemGuard.js";

export function writeFile(params) {
  const filePath = params?.path || params?.filePath;
  const content = params?.content;
  // Filesystem security check
  const guard = filesystemGuard.checkWrite(filePath);
  if (!guard.allowed) {
    console.log(`      [writeFile] BLOCKED: ${guard.reason}`);
    return guard.reason;
  }

  console.log(`      [writeFile] Writing to: ${filePath} (${content.length} chars)`);
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, { encoding: "utf-8" });
    console.log(`      [writeFile] Done`);
    return `File written successfully to ${filePath}`;
  } catch (error) {
    console.log(`      [writeFile] Failed: ${error.message}`);
    return `Error writing file: ${error.message}`;
  }
}

export const writeFileDescription =
  "writeFile(filePath: string, content: string) - Creates or overwrites a file with the given content. It will auto-create parent directories if they don't exist.";
