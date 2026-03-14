/**
 * AgentProfileManager — manages built-in + custom agent profiles.
 *
 * Built-in profiles from agentProfiles.js are read-only defaults.
 * Custom profiles stored in SQLite (agent_profiles table), per-tenant via tenant_id.
 *
 * Lookup priority: tenant-specific custom → global custom → built-in.
 * In-memory cache for O(1) lookups, invalidated on save/delete.
 */

import { agentProfiles, defaultSubAgentTools } from "./agentProfiles.js";
import { queryAll, queryOne, run } from "../storage/Database.js";

// ── Built-in profile conversion ──────────────────────────────────────────────

const _builtinCache = new Map();

function _initBuiltins() {
  if (_builtinCache.size > 0) return;
  for (const [id, tools] of Object.entries(agentProfiles)) {
    _builtinCache.set(id, {
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1),
      description: _builtinDescription(id),
      tools: [...tools],
      systemInstructions: "",
      model: null,
      isBuiltin: true,
      createdAt: null,
      updatedAt: null,
    });
  }
}

function _builtinDescription(id) {
  const descs = {
    researcher: "Gather, analyze, summarize, produce findings",
    coder: "Build, fix, test, verify code",
    writer: "Produce polished documents, reports, content",
    analyst: "Process data, run scripts, extract insights",
  };
  return descs[id] || "";
}

// ── Custom profile cache ─────────────────────────────────────────────────────

const _customCache = new Map(); // "tenantId:id" or "__global__:id" → profile
let _cacheLoaded = false;

function _cacheKey(id, tenantId) {
  return `${tenantId || "__global__"}:${id}`;
}

function _loadCustomCache() {
  if (_cacheLoaded) return;
  _cacheLoaded = true;
  try {
    const rows = queryAll("SELECT * FROM agent_profiles ORDER BY created_at ASC");
    for (const row of rows) {
      const profile = _rowToProfile(row);
      _customCache.set(_cacheKey(profile.id, row.tenant_id), profile);
    }
  } catch {
    // Table may not exist yet on fresh installs — safe to ignore
  }
}

function _invalidateCache() {
  _cacheLoaded = false;
  _customCache.clear();
}

function _rowToProfile(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    tools: JSON.parse(row.tools || "[]"),
    systemInstructions: row.system_instructions || "",
    model: row.model || null,
    isBuiltin: false,
    tenantId: row.tenant_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get a profile by ID.
 * Lookup priority: tenant-specific custom → global custom → built-in.
 * @param {string} id - Profile ID (slug)
 * @param {string|null} tenantId - Tenant ID for tenant-scoped lookup
 * @returns {object|null} Profile or null if not found
 */
export function getProfile(id, tenantId = null) {
  _initBuiltins();
  _loadCustomCache();

  // 1. Tenant-specific custom
  if (tenantId) {
    const tenantProfile = _customCache.get(_cacheKey(id, tenantId));
    if (tenantProfile) return { ...tenantProfile };
  }

  // 2. Global custom
  const globalProfile = _customCache.get(_cacheKey(id, null));
  if (globalProfile) return { ...globalProfile };

  // 3. Built-in
  const builtin = _builtinCache.get(id);
  if (builtin) return { ...builtin };

  return null;
}

/**
 * List all profiles (built-in + custom), merged.
 * Custom profiles with same ID as built-in override the built-in.
 * @param {string|null} tenantId
 * @returns {object[]}
 */
export function listProfiles(tenantId = null) {
  _initBuiltins();
  _loadCustomCache();

  const merged = new Map();

  // Start with built-ins
  for (const [id, profile] of _builtinCache) {
    merged.set(id, { ...profile });
  }

  // Overlay global custom profiles
  for (const [key, profile] of _customCache) {
    if (key.startsWith("__global__:")) {
      merged.set(profile.id, { ...profile });
    }
  }

  // Overlay tenant-specific custom profiles
  if (tenantId) {
    for (const [key, profile] of _customCache) {
      if (key.startsWith(`${tenantId}:`)) {
        merged.set(profile.id, { ...profile });
      }
    }
  }

  return [...merged.values()];
}

/**
 * Save (create or update) a custom profile.
 * @param {object} profile - { id, name, description?, tools, systemInstructions?, model? }
 * @param {string|null} tenantId
 * @returns {object} Saved profile
 */
export function saveProfile(profile, tenantId = null) {
  _initBuiltins();

  const { id, name, description, tools, systemInstructions, model } = profile;
  if (!id || !name) throw new Error("Profile id and name are required");
  if (!Array.isArray(tools) || tools.length === 0) throw new Error("Profile must have at least one tool");

  // Validate ID format (slug: lowercase, alphanumeric, hyphens)
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(id) && !/^[a-z0-9]$/.test(id)) {
    throw new Error("Profile id must be lowercase alphanumeric with hyphens (e.g., 'my-profile')");
  }

  // Don't allow overwriting built-in profiles at global scope (tenant overrides are OK)
  if (!tenantId && _builtinCache.has(id)) {
    throw new Error(`Cannot overwrite built-in profile "${id}" at global scope. Use a different id or save as tenant-specific.`);
  }

  const now = new Date().toISOString();
  const existing = queryOne(
    "SELECT id FROM agent_profiles WHERE id = $id AND COALESCE(tenant_id, '__global__') = $scope",
    { $id: id, $scope: tenantId || "__global__" }
  );

  if (existing) {
    run(
      `UPDATE agent_profiles SET name = $name, description = $desc, tools = $tools,
       system_instructions = $si, model = $model, updated_at = $now
       WHERE id = $id AND COALESCE(tenant_id, '__global__') = $scope`,
      {
        $id: id, $name: name, $desc: description || "",
        $tools: JSON.stringify(tools), $si: systemInstructions || "",
        $model: model || null, $now: now, $scope: tenantId || "__global__",
      }
    );
  } else {
    run(
      `INSERT INTO agent_profiles (id, tenant_id, name, description, tools, system_instructions, model, created_at, updated_at)
       VALUES ($id, $tid, $name, $desc, $tools, $si, $model, $now, $now)`,
      {
        $id: id, $tid: tenantId || null, $name: name, $desc: description || "",
        $tools: JSON.stringify(tools), $si: systemInstructions || "",
        $model: model || null, $now: now,
      }
    );
  }

  _invalidateCache();

  const saved = getProfile(id, tenantId);
  console.log(`[AgentProfileManager] Saved profile "${id}"${tenantId ? ` (tenant: ${tenantId})` : ""}`);
  return saved;
}

/**
 * Delete a custom profile.
 * @param {string} id
 * @param {string|null} tenantId
 * @returns {{ deleted: boolean, id: string }}
 */
export function deleteProfile(id, tenantId = null) {
  _initBuiltins();

  if (_builtinCache.has(id) && !tenantId) {
    throw new Error(`Cannot delete built-in profile "${id}"`);
  }

  const result = run(
    "DELETE FROM agent_profiles WHERE id = $id AND COALESCE(tenant_id, '__global__') = $scope",
    { $id: id, $scope: tenantId || "__global__" }
  );

  _invalidateCache();

  if (result.changes === 0) {
    throw new Error(`Profile "${id}" not found`);
  }

  console.log(`[AgentProfileManager] Deleted profile "${id}"${tenantId ? ` (tenant: ${tenantId})` : ""}`);
  return { deleted: true, id };
}

/**
 * Get all available tool names (for UI tool picker).
 * @returns {string[]}
 */
export function getAvailableTools() {
  return [...defaultSubAgentTools];
}
