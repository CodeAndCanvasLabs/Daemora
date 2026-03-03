import { resolve, sep } from "path";
import { config } from "../config/default.js";
import eventBus from "../core/EventBus.js";
import tenantContext from "../tenants/TenantContext.js";

/**
 * Filesystem Guard - restricts file access to safe paths.
 *
 * Two layers of protection:
 *
 * 1. HARDCODED BLOCKED PATTERNS - sensitive system files that are ALWAYS blocked
 *    (~/.ssh, .env, /etc/shadow, certificates, etc.)
 *
 * 2. USER-CONFIGURABLE SCOPING - like Docker volume mounts
 *    ALLOWED_PATHS=/Users/you/Downloads,/Users/you/Projects
 *      → Agent can ONLY access files inside those directories.
 *      → If unset: no directory restriction (global mode).
 *    BLOCKED_PATHS=/Users/you/Desktop,/Users/you/Documents
 *      → Always blocked regardless of ALLOWED_PATHS.
 *      → Useful for saying "everything except these folders".
 *
 * Examples:
 *   ALLOWED_PATHS=/home/john/workspace   → locked to workspace only
 *   BLOCKED_PATHS=/home/john/private     → blocks one folder, rest is open
 *   (neither set)                        → only hardcoded patterns blocked
 */

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
  // These are READ-blocked - not just write-blocked. An agent that can read
  // .env can exfiltrate every API key regardless of SecretScanner.
  /[\/\\]\.env$/,
  /[\/\\]\.env\.[^\/\\]+$/,    // .env.local, .env.production, etc.
  /^\.env$/,                   // relative path .env
  /^\.env\.[^\/\\]+$/,         // relative .env.local etc.
  // ── Agent config files (may contain plaintext API keys) ──────────────────
  // config/mcp.json stores MCP server credentials (GITHUB_TOKEN, Bearer tokens, etc.)
  // config/hooks.json and other agent config files are internal and agent-read-only.
  /[\/\\]config[\/\\]mcp\.json$/,
  /^config[\/\\]mcp\.json$/,
  /[\/\\]config[\/\\]hooks\.json$/,
  /^config[\/\\]hooks\.json$/,
  // ── Tenant data (contains AES-encrypted API keys + sensitive config) ───────
  /[\/\\]data[\/\\]tenants[\/\\][^\/\\]+\.json$/,
  /[\/\\]tenants\.json$/,
  // ── Audit / cost logs (operational data, not secrets, but limit exposure) ──
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

    // ── Resolve per-tenant or global path config ──────────────────────────────
    // When a task runs inside tenantContext.run(), use per-tenant resolved config.
    // Otherwise fall back to global filesystem config.
    const store = tenantContext.getStore();
    const resolvedConfig = store?.resolvedConfig;

    // ── Layer 2: User-defined blocked paths ───────────────────────────────────
    const userBlocked = resolvedConfig
      ? (resolvedConfig.blockedPaths || [])
      : (config.filesystem?.blockedPaths || []);
    for (const dir of userBlocked) {
      const dirResolved = resolve(dir);
      if (resolved === dirResolved || resolved.startsWith(dirResolved + sep) || resolved.startsWith(dirResolved + "/")) {
        this._block(operation, resolved, `user-blocked:${dir}`);
        return {
          allowed: false,
          reason: `Access denied: "${filePath}" is in a blocked directory ("${dir}").`,
        };
      }
    }

    // ── Layer 3: User-defined allowed paths (scoped mode) ─────────────────────
    const userAllowed = resolvedConfig
      ? (resolvedConfig.allowedPaths || [])
      : (config.filesystem?.allowedPaths || []);
    if (userAllowed.length > 0) {
      const inAllowed = userAllowed.some((dir) => {
        const dirResolved = resolve(dir);
        return resolved === dirResolved || resolved.startsWith(dirResolved + sep) || resolved.startsWith(dirResolved + "/");
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
