/**
 * Temp/workspace directory helper.
 * Uses os.tmpdir() as base. Auto-creates the directory.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * @param {string} [subdir] - e.g. "daemora-images", "daemora-tts"
 * @returns {string} absolute directory path (already created)
 */
export function getTenantTmpDir(subdir) {
  const dir = subdir ? join(tmpdir(), subdir) : tmpdir();
  if (subdir) mkdirSync(dir, { recursive: true });
  return dir;
}
