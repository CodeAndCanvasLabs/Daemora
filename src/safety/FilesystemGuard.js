import { resolve, sep } from "path";
import { realpathSync } from "fs";
import { config } from "../config/default.js";
import eventBus from "../core/EventBus.js";
import requestContext from "../core/RequestContext.js";

/**
 * Filesystem Guard - restricts file access to safe paths.
 *
 * Layers:
 *   1. Hardcoded BLOCKED_PATTERNS - sensitive files always blocked
 *   2. Hardcoded WRITE_BLOCKED_PATTERNS - system dirs write-blocked
 *   3. User blocked paths (global ∪ tenant) - always denied
 *   4. User allowed paths (global ∩ tenant) - if set, only these accessible
 *   5. Otherwise - allowed
 *
 * Path rules:
 *   - allowedPaths set → ONLY those dirs accessible, everything else blocked
 *   - blockedPaths set → those dirs denied, rest open
 *   - Both set → allowed dirs minus blocked dirs
 *   - Tenant can never exceed global (allowed = intersection, blocked = union)
 *   - Symlinks resolved to real path before checking
 *   - Case-insensitive comparison on macOS/Windows
 */

// Detect case-insensitive filesystem (macOS APFS, Windows NTFS)
const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";

// Paths the agent should NEVER read or write
const BLOCKED_PATTERNS = [
  // ── Credentials & keys ─────────────────────────────────────────────────────
  /\.ssh[\/\\]/,
  /\.gnupg[\/\\]/,
  /\.vault\.enc$/,
  /\.vault\.salt$/,
  /\/etc\/shadow/,
  /\/etc\/sudoers/,
  /\.aws\/credentials/,
  /\.docker\/config\.json/,
  /\.kube\/config/,
  /\.npmrc$/,
  /\.pypirc$/,
  /\.netrc$/,
  /id_rsa/,
  /id_ed25519/,
  /id_ecdsa/,
  /\.pem$/,
  /\.key$/,
  // ── Environment files (API keys in plaintext) ──────────────────────────────
  /[\/\\]\.env$/,
  /[\/\\]\.env\.[^\/\\]+$/,
  /^\.env$/,
  /^\.env\.[^\/\\]+$/,
  // ── Agent config files (may contain plaintext API keys) ──────────────────
  /[\/\\]config[\/\\]mcp\.json$/,
  /^config[\/\\]mcp\.json$/,
  /[\/\\]config[\/\\]hooks\.json$/,
  /^config[\/\\]hooks\.json$/,
  // ── Audit / cost logs ──────────────────────────────────────────────────────
  /[\/\\]data[\/\\]audit[\/\\]/,
];

// Patterns to block writing to (reading is ok)
const WRITE_BLOCKED_PATTERNS = [
  /\.env$/,
  /\.env\..+$/,
  /\/etc\//,
  /\/usr\//,
  /\/bin\//,
  /\/sbin\//,
  /\/System\//,
  /\/Library\/LaunchDaemons\//,
];

/**
 * Normalize a path for comparison: resolve, follow symlinks, case-fold on
 * case-insensitive filesystems.
 */
function normalizePath(p) {
  let norm = resolve(p);
  try { norm = realpathSync(norm); } catch { /* path may not exist yet - use resolved */ }
  if (CASE_INSENSITIVE) norm = norm.toLowerCase();
  return norm;
}

/**
 * Check if `child` is equal to or inside `parent`.
 */
function isInsideDir(child, parent) {
  return child === parent || child.startsWith(parent + sep) || child.startsWith(parent + "/");
}

class FilesystemGuard {
  constructor() {
    this.blockedCount = 0;
  }

  /**
   * Check if a read operation is allowed.
   * @param {string} filePath
   * @returns {{ allowed: boolean, reason?: string }}
   */
  checkRead(filePath) {
    return this._check(filePath, "read");
  }

  /**
   * Check if a write operation is allowed.
   * @param {string} filePath
   * @returns {{ allowed: boolean, reason?: string }}
   */
  checkWrite(filePath) {
    return this._check(filePath, "write");
  }

  _check(filePath, operation) {
    if (!filePath) return { allowed: false, reason: "No file path provided" };

    const resolved = resolve(filePath);

    // ── Layer 1: Hardcoded blocked patterns ───────────────────────────────────
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(resolved)) {
        this._block(operation, resolved, pattern.toString());
        return {
          allowed: false,
          reason: `Access denied: "${filePath}" matches a blocked path pattern (sensitive file).`,
        };
      }
    }

    if (operation === "write") {
      for (const pattern of WRITE_BLOCKED_PATTERNS) {
        if (pattern.test(resolved)) {
          this._block(operation, resolved, pattern.toString());
          return {
            allowed: false,
            reason: `Write access denied: "${filePath}" is in a protected system directory.`,
          };
        }
      }
    }

    // ── Normalize for directory checks (symlink + case-fold) ─────────────────
    const norm = normalizePath(filePath);

    // ── Resolve per-tenant or global path config ────────────────────────────
    // resolvedConfig already has merged paths (global ∪ tenant for blocked,
    // global ∩ tenant for allowed) - computed by TenantManager.resolveTaskConfig().
    const store = requestContext.getStore();
    const resolvedConfig = store?.resolvedConfig;

    // ── Layer 2: User-defined blocked paths (global ∪ tenant) ────────────────
    const userBlocked = resolvedConfig
      ? (resolvedConfig.blockedPaths || [])
      : (config.filesystem?.blockedPaths || []);
    for (const dir of userBlocked) {
      const dirNorm = normalizePath(dir);
      if (isInsideDir(norm, dirNorm)) {
        this._block(operation, resolved, `user-blocked:${dir}`);
        return {
          allowed: false,
          reason: `Access denied: "${filePath}" is in a blocked directory ("${dir}").`,
        };
      }
    }

    // ── Layer 3: User-defined allowed paths (scoped mode) ────────────────────
    const userAllowed = resolvedConfig
      ? (resolvedConfig.allowedPaths || [])
      : (config.filesystem?.allowedPaths || []);
    if (userAllowed.length > 0) {
      const inAllowed = userAllowed.some((dir) => {
        const dirNorm = normalizePath(dir);
        return isInsideDir(norm, dirNorm);
      });

      if (!inAllowed) {
        this._block(operation, resolved, "outside-allowed-paths");
        const hint = resolvedConfig?.allowedPaths?.length
          ? `Your workspace: ${userAllowed.join(", ")}.`
          : `Allowed: ${userAllowed.join(", ")}. Add more directories to ALLOWED_PATHS in .env, or clear it to allow global access.`;
        return {
          allowed: false,
          reason: `Access denied: "${filePath}" is outside the allowed directories. ${hint}`,
        };
      }
    }

    return { allowed: true };
  }

  _block(operation, path, reason) {
    this.blockedCount++;
    eventBus.emitEvent("filesystem:blocked", { operation, path, reason });
  }

  stats() {
    return { blockedCount: this.blockedCount };
  }
}

const filesystemGuard = new FilesystemGuard();
export default filesystemGuard;
