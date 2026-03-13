/**
 * Backward-compat merge for tool params during schema migration.
 *
 * Old schema: { action: "...", params: '{"key":"val"}' }  or  { field: "...", options: '{"key":"val"}' }
 * New schema: { action: "...", key: "val" }               or  { field: "...", key: "val" }
 *
 * These helpers merge legacy JSON strings with flat fields so both formats work.
 */

/**
 * Merge legacy `params` JSON string with flat fields.
 * For action-based tools (gitTool, taskManager, etc.).
 * Returns merged params object (excludes `action` and `params` keys).
 */
export function mergeLegacyParams(toolParams) {
  const paramsStr = toolParams?.params;
  const legacy = paramsStr
    ? (typeof paramsStr === "string" ? JSON.parse(paramsStr) : paramsStr)
    : {};
  const { params: _, action: _a, ...rest } = toolParams || {};
  return { ...legacy, ...rest };
}

/**
 * Merge legacy `options` JSON string with flat fields.
 * For tools that had { field, options: '{"key":"val"}' }.
 * Excludes the specified top-level keys from the merge.
 */
export function mergeLegacyOptions(params, topLevelKeys = []) {
  const optStr = params?.options;
  const legacy = optStr
    ? (typeof optStr === "string" ? JSON.parse(optStr) : optStr)
    : {};
  const skip = new Set(["options", ...topLevelKeys]);
  const flat = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (!skip.has(k) && v !== undefined) flat[k] = v;
  }
  return { ...legacy, ...flat };
}
