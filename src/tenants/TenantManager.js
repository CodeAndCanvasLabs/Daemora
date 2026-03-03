import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "node:crypto";
import { config } from "../config/default.js";

/**
 * TenantManager - per-user configuration and isolation for multi-tenant deployments.
 *
 * A tenant is any unique user identified by their channel + userId:
 *   tenantId = "telegram:123456789"
 *   tenantId = "slack:U012AB3CD"
 *   tenantId = "email:user@example.com"
 *
 * Each tenant can have:
 *   model          - override the default model (e.g. cheaper model for free tier)
 *   allowedPaths   - filesystem paths this tenant's tasks can access
 *   blockedPaths   - paths always blocked for this tenant
 *   maxCostPerTask - per-task spend limit (overrides global)
 *   maxDailyCost   - per-tenant daily budget
 *   tools          - tool allowlist (empty = all tools allowed by permission tier)
 *   mcpServers     - MCP server allowlist: ["github","linear"] | null (null = all allowed)
 *   modelRoutes    - task-type model overrides: { coder: "anthropic:...", researcher: "google:..." }
 *   encryptedApiKeys - AES-256-GCM encrypted per-tenant API keys (managed via setApiKey/deleteApiKey)
 *   suspended      - block all tasks from this tenant
 *   plan           - "free" | "pro" | "admin" (for display / future rate limiting)
 *   createdAt      - ISO timestamp of first message
 *   lastSeenAt     - ISO timestamp of last message
 *   totalCost      - lifetime spend for this tenant
 *   taskCount      - total tasks submitted
 *   notes          - free-text operator notes
 *
 * Storage: data/tenants/tenants.json (flat JSON map of tenantId → config)
 * Workspaces: data/tenants/{tenantId}/workspace/  (isolated per-tenant directory)
 */

const TENANTS_PATH = join(config.dataDir, "tenants", "tenants.json");
const TENANTS_DIR = join(config.dataDir, "tenants");

// ── Per-tenant API key encryption (AES-256-GCM) ───────────────────────────────
// Keys are stored as "iv:authTag:ciphertext" in tenant.encryptedApiKeys.
// The master key is derived from DAEMORA_TENANT_KEY env var via scrypt.
// If DAEMORA_TENANT_KEY is not set, an insecure dev fallback is used (warns via daemora doctor).

const _TENANT_CIPHER = "aes-256-gcm";
const _TENANT_SALT   = "daemora-tenant-keys-v1";

function _getTenantKey() {
  const master = process.env.DAEMORA_TENANT_KEY || "daemora-dev-insecure-fallback";
  return scryptSync(master, _TENANT_SALT, 32);
}

function _encryptTenantValue(plaintext) {
  const key = _getTenantKey();
  const iv  = randomBytes(16);
  const cipher = createCipheriv(_TENANT_CIPHER, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

function _decryptTenantValue(str) {
  try {
    const parts = str.split(":");
    if (parts.length < 3) return null;
    const [ivHex, tagHex, ...cipherParts] = parts;
    const cipherHex = cipherParts.join(":");
    const key = _getTenantKey();
    const iv  = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const enc = Buffer.from(cipherHex, "hex");
    const decipher = createDecipheriv(_TENANT_CIPHER, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc).toString("utf8") + decipher.final("utf8");
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

class TenantManager {
  constructor() {
    this._cache = null; // in-memory cache, invalidated on write
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Get or auto-create a tenant record.
   * Called on every incoming message to apply per-tenant config.
   */
  getOrCreate(channel, userId) {
    const id = _makeId(channel, userId);
    const tenants = this._load();

    if (!tenants[id]) {
      if (!config.multiTenant?.autoRegister) return null;
      tenants[id] = _defaultTenant(id);
      this._save(tenants);
    } else {
      // Update lastSeenAt on every access
      tenants[id].lastSeenAt = new Date().toISOString();
      this._save(tenants);
    }

    return { id, ...tenants[id] };
  }

  /**
   * Get tenant by ID. Returns null if not found.
   */
  get(tenantId) {
    const tenants = this._load();
    if (!tenants[tenantId]) return null;
    return { id: tenantId, ...tenants[tenantId] };
  }

  /**
   * List all tenants.
   */
  list() {
    const tenants = this._load();
    return Object.entries(tenants).map(([id, t]) => ({ id, ...t }));
  }

  /**
   * Update tenant config (partial update - only provided keys are changed).
   */
  set(tenantId, updates) {
    const tenants = this._load();
    if (!tenants[tenantId]) {
      tenants[tenantId] = _defaultTenant(tenantId);
    }
    const allowed = [
      "model", "allowedPaths", "blockedPaths", "maxCostPerTask",
      "maxDailyCost", "tools", "suspended", "plan", "notes",
      "modelRoutes", "mcpServers",
    ];
    for (const key of allowed) {
      if (updates[key] !== undefined) tenants[tenantId][key] = updates[key];
    }
    tenants[tenantId].updatedAt = new Date().toISOString();
    this._save(tenants);
    return { id: tenantId, ...tenants[tenantId] };
  }

  /**
   * Record task cost against this tenant's lifetime totals.
   */
  recordCost(tenantId, cost) {
    if (!tenantId || !cost) return;
    const tenants = this._load();
    if (!tenants[tenantId]) return;
    tenants[tenantId].totalCost = (tenants[tenantId].totalCost || 0) + cost;
    tenants[tenantId].taskCount = (tenants[tenantId].taskCount || 0) + 1;
    this._save(tenants);
  }

  /**
   * Suspend a tenant (all their tasks will be rejected).
   */
  suspend(tenantId, reason = "") {
    return this.set(tenantId, { suspended: true, suspendReason: reason });
  }

  /**
   * Unsuspend a tenant.
   */
  unsuspend(tenantId) {
    return this.set(tenantId, { suspended: false, suspendReason: "" });
  }

  /**
   * Reset a tenant's config back to defaults (keep cost history).
   */
  reset(tenantId) {
    const tenants = this._load();
    if (!tenants[tenantId]) return null;
    const preserved = {
      totalCost: tenants[tenantId].totalCost || 0,
      taskCount: tenants[tenantId].taskCount || 0,
      createdAt: tenants[tenantId].createdAt,
    };
    tenants[tenantId] = { ..._defaultTenant(tenantId), ...preserved };
    this._save(tenants);
    return { id: tenantId, ...tenants[tenantId] };
  }

  /**
   * Delete a tenant record entirely.
   */
  delete(tenantId) {
    const tenants = this._load();
    if (!tenants[tenantId]) return false;
    delete tenants[tenantId];
    this._save(tenants);
    return true;
  }

  // ── Per-Tenant Channel Config ─────────────────────────────────────────────

  /**
   * Store a per-tenant channel credential, encrypted with AES-256-GCM.
   * Valid keys: email, email_password, resend_api_key, resend_from
   *
   * @param {string} tenantId - e.g. "telegram:123"
   * @param {string} key      - e.g. "email"
   * @param {string} value    - plaintext credential value
   */
  setChannelConfig(tenantId, key, value) {
    const tenants = this._load();
    if (!tenants[tenantId]) tenants[tenantId] = _defaultTenant(tenantId);
    tenants[tenantId].encryptedChannelConfig = tenants[tenantId].encryptedChannelConfig || {};
    tenants[tenantId].encryptedChannelConfig[key] = _encryptTenantValue(value);
    tenants[tenantId].updatedAt = new Date().toISOString();
    this._save(tenants);
    return true;
  }

  /**
   * Delete a per-tenant channel credential.
   */
  deleteChannelConfig(tenantId, key) {
    const tenants = this._load();
    if (!tenants[tenantId]?.encryptedChannelConfig?.[key]) return false;
    delete tenants[tenantId].encryptedChannelConfig[key];
    tenants[tenantId].updatedAt = new Date().toISOString();
    this._save(tenants);
    return true;
  }

  /**
   * List the credential keys stored for a tenant (not values).
   */
  listChannelConfigKeys(tenantId) {
    const tenants = this._load();
    return Object.keys(tenants[tenantId]?.encryptedChannelConfig || {});
  }

  /**
   * Decrypt and return all channel credentials for a tenant.
   * Returns {} if none stored.
   */
  getDecryptedChannelConfig(tenantId) {
    const tenants = this._load();
    const encrypted = tenants[tenantId]?.encryptedChannelConfig || {};
    const result = {};
    for (const [key, val] of Object.entries(encrypted)) {
      const decrypted = _decryptTenantValue(val);
      if (decrypted !== null) result[key] = decrypted;
    }
    return result;
  }

  // ── Per-Tenant API Key Management ─────────────────────────────────────────

  /**
   * Store a per-tenant API key, encrypted with AES-256-GCM.
   * The key is stored in tenant.encryptedApiKeys[keyName].
   *
   * @param {string} tenantId - e.g. "telegram:123"
   * @param {string} keyName  - e.g. "OPENAI_API_KEY"
   * @param {string} keyValue - plaintext key value
   */
  setApiKey(tenantId, keyName, keyValue) {
    const tenants = this._load();
    if (!tenants[tenantId]) tenants[tenantId] = _defaultTenant(tenantId);
    tenants[tenantId].encryptedApiKeys = tenants[tenantId].encryptedApiKeys || {};
    tenants[tenantId].encryptedApiKeys[keyName] = _encryptTenantValue(keyValue);
    tenants[tenantId].updatedAt = new Date().toISOString();
    this._save(tenants);
    return true;
  }

  /**
   * Delete a per-tenant API key.
   *
   * @param {string} tenantId
   * @param {string} keyName
   * @returns {boolean} true if deleted, false if not found
   */
  deleteApiKey(tenantId, keyName) {
    const tenants = this._load();
    if (!tenants[tenantId]?.encryptedApiKeys?.[keyName]) return false;
    delete tenants[tenantId].encryptedApiKeys[keyName];
    tenants[tenantId].updatedAt = new Date().toISOString();
    this._save(tenants);
    return true;
  }

  /**
   * List the names (not values) of stored API keys for a tenant.
   *
   * @param {string} tenantId
   * @returns {string[]} key names
   */
  listApiKeyNames(tenantId) {
    const tenants = this._load();
    return Object.keys(tenants[tenantId]?.encryptedApiKeys || {});
  }

  /**
   * Decrypt and return all stored API keys for a tenant.
   * Returns {} if none stored or decryption fails.
   * These are passed through the call stack (NOT via process.env) to prevent cross-tenant bleed.
   *
   * @param {string} tenantId
   * @returns {object} e.g. { OPENAI_API_KEY: "sk-...", ANTHROPIC_API_KEY: "sk-ant-..." }
   */
  getDecryptedApiKeys(tenantId) {
    const tenants = this._load();
    const encrypted = tenants[tenantId]?.encryptedApiKeys || {};
    const result = {};
    for (const [key, val] of Object.entries(encrypted)) {
      const decrypted = _decryptTenantValue(val);
      if (decrypted !== null) result[key] = decrypted;
    }
    return result;
  }

  // ── Workspace ─────────────────────────────────────────────────────────────

  /**
   * Get (and create if missing) the isolated workspace directory for a tenant.
   * This is the default allowed path when sandbox mode is active.
   */
  getWorkspace(tenantId) {
    const safe = tenantId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const dir = join(TENANTS_DIR, safe, "workspace");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ── Effective config resolution ───────────────────────────────────────────

  /**
   * Resolve the effective config for a task, merging:
   *   tenant config > channel config > global config > defaults
   *
   * Returns the values TaskRunner should use for this specific task.
   */
  resolveTaskConfig(tenant, channelModel) {
    const sandboxEnabled = config.sandbox?.mode === "docker" || config.multiTenant?.isolateFilesystem;

    // Filesystem: tenant paths > global paths > (if sandbox) tenant workspace only
    let allowedPaths = tenant?.allowedPaths?.length
      ? tenant.allowedPaths
      : config.filesystem?.allowedPaths || [];

    // If sandbox mode and tenant has no custom paths, default to their workspace
    if (sandboxEnabled && allowedPaths.length === 0 && tenant?.id) {
      allowedPaths = [this.getWorkspace(tenant.id)];
    }

    const blockedPaths = tenant?.blockedPaths?.length
      ? tenant.blockedPaths
      : config.filesystem?.blockedPaths || [];

    return {
      model: tenant?.model || channelModel || config.defaultModel,
      allowedPaths,
      blockedPaths,
      restrictCommands: config.filesystem?.restrictCommands || false,
      maxCostPerTask: tenant?.maxCostPerTask ?? config.maxCostPerTask,
      maxDailyCost: tenant?.maxDailyCost ?? config.maxDailyCost,
      tools: tenant?.tools || null,       // null = all tools allowed
      sandbox: config.sandbox?.mode || "process",
      mcpServers: tenant?.mcpServers ?? null,          // null = all MCP servers allowed
      modelRoutes: tenant?.modelRoutes || null,         // null = use global env vars
      apiKeys: tenant?.id ? this.getDecryptedApiKeys(tenant.id) : {},          // per-tenant AI provider keys
      channelConfig: tenant?.id ? this.getDecryptedChannelConfig(tenant.id) : {},  // per-tenant channel credentials
    };
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _load() {
    if (this._cache) return this._cache;
    mkdirSync(TENANTS_DIR, { recursive: true });
    if (!existsSync(TENANTS_PATH)) return {};
    try {
      this._cache = JSON.parse(readFileSync(TENANTS_PATH, "utf-8"));
      return this._cache;
    } catch {
      return {};
    }
  }

  _save(tenants) {
    mkdirSync(TENANTS_DIR, { recursive: true });
    writeFileSync(TENANTS_PATH, JSON.stringify(tenants, null, 2), "utf-8");
    this._cache = tenants;
  }

  stats() {
    const tenants = this._load();
    const list = Object.values(tenants);
    return {
      total: list.length,
      suspended: list.filter(t => t.suspended).length,
      totalCost: list.reduce((s, t) => s + (t.totalCost || 0), 0).toFixed(4),
      totalTasks: list.reduce((s, t) => s + (t.taskCount || 0), 0),
    };
  }
}

function _makeId(channel, userId) {
  return `${channel}:${userId}`;
}

function _defaultTenant(id) {
  return {
    model: null,
    allowedPaths: [],
    blockedPaths: [],
    maxCostPerTask: null,
    maxDailyCost: null,
    tools: null,
    mcpServers: null,              // null = all MCP servers allowed; ["github","linear"] = allowlist
    modelRoutes: null,             // null = use global env vars; { coder: "anthropic:..." }
    encryptedApiKeys: {},          // AES-256-GCM encrypted per-tenant AI provider keys
    encryptedChannelConfig: {},    // AES-256-GCM encrypted per-tenant channel credentials (email, resend, etc.)
    suspended: false,
    suspendReason: "",
    plan: "free",
    notes: "",
    totalCost: 0,
    taskCount: 0,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const tenantManager = new TenantManager();
export default tenantManager;
