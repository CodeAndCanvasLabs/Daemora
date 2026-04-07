/**
 * Media/workspace directory helper.
 * Uses data/media/ as base for persistent storage (survives reboots).
 * Falls back to os.tmpdir() if data dir is not writable.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/default.js";

/**
 * Get a persistent media directory under data/media/.
 * @param {string} [subdir] - e.g. "images", "tts", "videos", "music", "captures"
 * @returns {string} absolute directory path (already created)
 */
export function getTenantTmpDir(subdir) {
  const base = join(config.dataDir, "media");
  const dir = subdir ? join(base, subdir) : base;
  mkdirSync(dir, { recursive: true });
  return dir;
}
