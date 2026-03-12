/**
 * Tenant-aware environment variable resolution.
 * Priority: tenant apiKeys → process.env
 */
import tenantContext from "../tenants/TenantContext.js";

/**
 * Resolve a key from tenant context first, then process.env.
 * @param {string} name - e.g. "BRAVE_API_KEY"
 * @returns {string|undefined}
 */
export function resolveKey(name) {
  const store = tenantContext.getStore();
  return store?.apiKeys?.[name] || process.env[name];
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
