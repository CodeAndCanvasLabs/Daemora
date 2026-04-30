/**
 * Loopback file-token — the "same-machine script access" escape hatch.
 *
 * Writes a 32-byte random token to `{dataDir}/auth-token` with 0600
 * perms. The middleware accepts it ONLY when the request arrived over
 * loopback (127.0.0.1 / ::1). Remote requests hitting the same endpoint
 * with this token are rejected.
 *
 * Why this is safe:
 *   - File perm 0600 limits read to the owning UID. Any process
 *     already running as your user has full access anyway — this
 *     token just lets them talk to Daemora over HTTP without a full
 *     login flow (curl, scripts, the desktop app).
 *   - The loopback check uses `req.socket.remoteAddress` directly
 *     (not headers) so X-Forwarded-For spoofing doesn't bypass.
 *
 * The UI in the desktop/dev build reads this via server-injected
 * `<meta name="api-token">` — same pattern as the JS daemora.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

import { createLogger } from "../util/logger.js";

const log = createLogger("auth.filetoken");

export function getOrCreateFileToken(dataDir: string): string {
  const path = join(dataDir, "auth-token");
  if (existsSync(path)) {
    const token = readFileSync(path, "utf-8").trim();
    if (token.length >= 32) return token;
  }
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, "utf-8");
  // chmod 0600 — only the owner can read. Some OS (Windows) may not
  // enforce, but the file path is still inside the user's data dir.
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  log.info("loopback auth token generated");
  return token;
}

/**
 * Constant-time comparison. Use for every token-vs-token check to avoid
 * timing-based side channels revealing prefix matches.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Is the socket peer a loopback address? Uses the TCP peer directly,
 * ignoring X-Forwarded-For / X-Real-IP so a malicious proxy can't
 * pretend to be local. If you're running Daemora behind a reverse
 * proxy on the same host, you're fine — the peer IS localhost.
 */
export function isLoopback(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return (
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1"
  );
}
