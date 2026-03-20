/**
 * Tenant-aware environment variable resolution.
 * Priority: tenant apiKeys → process.env
 */
import tenantContext from "../tenants/TenantContext.js";

// Lazy-loaded audit logger — avoids circular dep with Database.js at import time
let _logAccess = null;
function _auditSecretAccess(name, tenantId, source) {
  try {
    if (!_logAccess) {
      // Lazy init — import DB only when first secret is accessed
      import("../storage/Database.js").then(({ run }) => {
        _logAccess = (n, tid, src) => {
          try {
            run(
              "INSERT INTO secret_access_log (caller, key_name, tenant_id, source) VALUES ($c, $k, $t, $s)",
              { $c: src || "tool", $k: n, $t: tid || null, $s: src || "resolveKey" }
            );
          } catch { /* non-fatal — never block tool execution for audit */ }
        };
        _logAccess(name, tenantId, source);
      }).catch(() => {});
      return;
    }
    _logAccess(name, tenantId, source);
  } catch { /* non-fatal */ }
}

/**
 * Resolve a key from tenant context first, then process.env.
 * @param {string} name - e.g. "BRAVE_API_KEY"
 * @returns {string|undefined}
 */
export function resolveKey(name) {
  const store = tenantContext.getStore();
  const value = store?.apiKeys?.[name] || process.env[name];
  // Audit trail — log every secret access (async, non-blocking)
  if (value) _auditSecretAccess(name, store?.tenant?.id, "resolveKey");
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
