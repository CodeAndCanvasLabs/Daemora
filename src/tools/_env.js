/**
 * Environment variable resolution.
 * Reads from process.env.
 */

// Lazy-loaded audit logger - avoids circular dep with Database.js at import time
let _logAccess = null;
function _auditSecretAccess(name, source) {
  try {
    if (!_logAccess) {
      // Lazy init - import DB only when first secret is accessed
      import("../storage/Database.js").then(({ run }) => {
        _logAccess = (n, src) => {
          try {
            run(
              "INSERT INTO secret_access_log (caller, key_name, source) VALUES ($c, $k, $s)",
              { $c: src || "tool", $k: n, $s: src || "resolveKey" }
            );
          } catch { /* non-fatal - never block tool execution for audit */ }
        };
        _logAccess(name, source);
      }).catch(() => {});
      return;
    }
    _logAccess(name, source);
  } catch { /* non-fatal */ }
}

/**
 * Resolve a key from process.env.
 * @param {string} name - e.g. "BRAVE_API_KEY"
 * @returns {string|undefined}
 */
export function resolveKey(name) {
  const value = process.env[name];
  // Audit trail - log every secret access (async, non-blocking)
  if (value) _auditSecretAccess(name, "resolveKey");
  return value;
}

/**
 * Resolve multiple keys at once.
 * @param {...string} names
 * @returns {Record<string, string|undefined>}
 */
export function resolveKeys(...names) {
  const result = {};
  for (const name of names) result[name] = resolveKey(name);
  return result;
}
