import { mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "node:crypto";
import { config } from "../config/default.js";
import { resolveDefaultModel } from "../models/ModelRouter.js";
import { queryAll, queryOne, run, transaction } from "../storage/Database.js";

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
 * Storage: SQLite tenants table (config column = JSON blob of full tenant config)
 * Workspaces: data/tenants/{tenantId}/workspace/  (isolated per-tenant directory)
 */

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
  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Get or auto-create a tenant record.
   * Looks up by channel identity - one tenant can have multiple linked channels.
   * Called on every incoming message to apply per-tenant config.
   */
  getOrCreate(channel, userId) {
    // 1. Look up channel identity → tenant_id
    const channelRow = queryOne(
      "SELECT tenant_id FROM tenant_channels WHERE channel = $ch AND user_id = $uid",
      { $ch: channel, $uid: userId }
    );

    if (channelRow) {
      const row = queryOne("SELECT * FROM tenants WHERE id = $id", { $id: channelRow.tenant_id });
      if (row) {
        const cfg = _parseConfig(row);
        cfg.lastSeenAt = new Date().toISOString();
        _updateRow(channelRow.tenant_id, cfg);
        return { id: channelRow.tenant_id, ...cfg };
      }
    }

    // 2. No identity found - create new tenant (channel:userId id for backward compat)
    if (!config.multiTenant?.autoRegister) return null;
    const id = _makeId(channel, userId);
    const t = _defaultTenant(id);
    transaction(() => {
      run(
        `INSERT OR IGNORE INTO tenants (id, config, created_at, last_seen_at, suspended, suspend_reason)
         VALUES ($id, $config, $created_at, $last_seen_at, 0, NULL)`,
        { $id: id, $config: JSON.stringify(t), $created_at: t.createdAt, $last_seen_at: t.lastSeenAt }
      );
      run(
        "INSERT OR IGNORE INTO tenant_channels (channel, user_id, tenant_id) VALUES ($ch, $uid, $tid)",
        { $ch: channel, $uid: userId, $tid: id }
      );
    });
    return { id, ...t };
  }

  /**
   * Link an additional channel identity to an existing tenant.
   * Enables the same person to be recognized across Discord, Telegram, Slack, etc.
   * Stores routing metadata (chatId, channelId, phone, etc.) for cross-channel sends.
   * Throws if the channel identity is already linked to a different tenant.
   * @param {string} tenantId
   * @param {string} channel - "telegram", "discord", "slack", etc.
   * @param {string} userId - Platform-specific user/chat ID
   * @param {object} [routingMeta] - Full channelMeta for cross-channel routing (chatId, channelId, phone, etc.)
   */
  linkChannel(tenantId, channel, userId, routingMeta = null) {
    const row = queryOne("SELECT id FROM tenants WHERE id = $id", { $id: tenantId });
    if (!row) throw new Error(`Tenant "${tenantId}" not found`);

    const existing = queryOne(
      "SELECT tenant_id FROM tenant_channels WHERE channel = $ch AND user_id = $uid",
      { $ch: channel, $uid: userId }
    );
    if (existing && existing.tenant_id !== tenantId) {
      throw new Error(`${channel}:${userId} is already linked to tenant "${existing.tenant_id}"`);
    }

    const metaJson = routingMeta ? JSON.stringify(routingMeta) : null;

    if (existing) {
      // Update routing metadata if we have new data
      if (metaJson) {
        run(
          "UPDATE tenant_channels SET meta = $meta WHERE channel = $ch AND user_id = $uid",
          { $ch: channel, $uid: userId, $meta: metaJson }
        );
      }
    } else {
      run(
        "INSERT INTO tenant_channels (channel, user_id, tenant_id, meta) VALUES ($ch, $uid, $tid, $meta)",
        { $ch: channel, $uid: userId, $tid: tenantId, $meta: metaJson }
      );
    }
    return true;
  }

  /**
   * Unlink a channel identity from a tenant.
   * Refuses if it's the last identity - tenant would become unreachable.
   */
  unlinkChannel(tenantId, channel, userId) {
    const count = queryOne(
      "SELECT COUNT(*) as cnt FROM tenant_channels WHERE tenant_id = $tid",
      { $tid: tenantId }
    );
    if (count.cnt <= 1) {
      throw new Error("Cannot unlink the last channel identity - tenant would become unreachable");
    }
    run(
      "DELETE FROM tenant_channels WHERE channel = $ch AND user_id = $uid AND tenant_id = $tid",
      { $ch: channel, $uid: userId, $tid: tenantId }
    );
    return true;
  }

  /**
   * List all channel identities linked to a tenant (with routing metadata).
   */
  getChannels(tenantId) {
    const rows = queryAll(
      "SELECT channel, user_id, linked_at, meta FROM tenant_channels WHERE tenant_id = $tid ORDER BY linked_at ASC",
      { $tid: tenantId }
    );
    return rows.map(r => ({
      ...r,
      meta: r.meta ? JSON.parse(r.meta) : null,
    }));
  }

  /**
   * Get tenant by ID. Returns null if not found.
   */
  get(tenantId) {
    const row = queryOne("SELECT * FROM tenants WHERE id = $id", { $id: tenantId });
    if (!row) return null;
    return { id: tenantId, ..._parseConfig(row) };
  }

  /**
   * List all tenants.
   */
  list() {
    return queryAll("SELECT * FROM tenants ORDER BY created_at DESC").map(row => ({
      id: row.id,
      ..._parseConfig(row),
    }));
  }

  /**
   * Update tenant config (partial update - only provided keys are changed).
   */
  set(tenantId, updates) {
    // Validate path arrays before applying
    for (const field of ["allowedPaths", "blockedPaths"]) {
      if (updates[field] !== undefined) {
        if (!Array.isArray(updates[field])) {
          throw new Error(`${field} must be an array`);
        }
        for (const p of updates[field]) {
          if (typeof p !== "string") {
            throw new Error(`${field} must contain strings`);
          }
          const isUnixAbs = p.startsWith("/");
          const isWinAbs = /^[A-Za-z]:[\\\/]/.test(p);
          if (!isUnixAbs && !isWinAbs) {
            throw new Error(`${field} must contain absolute paths (got "${p}")`);
          }
          if (p.includes("\0")) {
            throw new Error(`${field} must not contain null bytes`);
          }
          const normalized = p.replace(/\\/g, "/");
          if (/(^|\/)\.\.(\/|$)/.test(normalized)) {
            throw new Error(`${field} must not contain ".." path traversal (got "${p}")`);
          }
          if (p.length > 4096) {
            throw new Error(`${field} path too long (max 4096 chars)`);
          }
          if (/[\x00-\x1f]/.test(p)) {
            throw new Error(`${field} must not contain control characters`);
          }
        }
      }
    }

    let row = queryOne("SELECT * FROM tenants WHERE id = $id", { $id: tenantId });
    let cfg;
    if (!row) {
      cfg = _defaultTenant(tenantId);
    } else {
      cfg = _parseConfig(row);
    }

    const allowed = [
      "model", "allowedPaths", "blockedPaths", "maxCostPerTask",
      "maxDailyCost", "tools", "blockedTools", "suspended", "plan", "notes",
      "modelRoutes", "mcpServers", "ownMcpServers", "plugins", "globalAdmin",
    ];
    for (const key of allowed) {
      if (updates[key] !== undefined) cfg[key] = updates[key];
    }
    cfg.updatedAt = new Date().toISOString();

    if (!row) {
      run(
        `INSERT INTO tenants (id, config, created_at, last_seen_at, suspended, suspend_reason)
         VALUES ($id, $config, $created_at, $last_seen_at, $suspended, $suspend_reason)`,
        {
          $id: tenantId,
          $config: JSON.stringify(cfg),
          $created_at: cfg.createdAt,
          $last_seen_at: cfg.lastSeenAt,
          $suspended: cfg.suspended ? 1 : 0,
          $suspend_reason: cfg.suspendReason || null,
        }
      );
    } else {
      _updateRow(tenantId, cfg);
    }

    return { id: tenantId, ...cfg };
  }

  /**
   * Record task cost against this tenant's lifetime totals.
   */
  recordCost(tenantId, cost) {
    if (!tenantId || !cost) return;
    const row = queryOne("SELECT * FROM tenants WHERE id = $id", { $id: tenantId });
    if (!row) return;
    const cfg = _parseConfig(row);
    cfg.totalCost = (cfg.totalCost || 0) + cost;
    cfg.taskCount = (cfg.taskCount || 0) + 1;
    _updateRow(tenantId, cfg);
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
   * Find the global admin tenant (first tenant marked as globalAdmin).
   * All global channel identities share this single tenant.
   */
  findGlobalTenant() {
    const row = queryOne("SELECT * FROM tenants WHERE config LIKE '%\"globalAdmin\":true%'");
    if (!row) return null;
    return { id: row.id, ..._parseConfig(row) };
  }

  /**
   * Mark a tenant as the global admin tenant.
   */
  markAsGlobal(tenantId) {
    this.set(tenantId, { globalAdmin: true });
  }

  /**
   * Reset a tenant's config back to defaults (keep cost history).
   */
  reset(tenantId) {
    const row = queryOne("SELECT * FROM tenants WHERE id = $id", { $id: tenantId });
    if (!row) return null;
    const old = _parseConfig(row);
    const preserved = {
      totalCost: old.totalCost || 0,
      taskCount: old.taskCount || 0,
      createdAt: old.createdAt,
    };
    const cfg = { ..._defaultTenant(tenantId), ...preserved };
    _updateRow(tenantId, cfg);
    return { id: tenantId, ...cfg };
  }

  /**
   * Delete a tenant record entirely.
   */
  delete(tenantId) {
    const row = queryOne("SELECT id FROM tenants WHERE id = $id", { $id: tenantId });
    if (!row) return false;
    run("DELETE FROM tenants WHERE id = $id", { $id: tenantId });
    return true;
  }

  // ── Per-Tenant Channel Config ─────────────────────────────────────────────

  /**
   * Store a per-tenant channel credential, encrypted with AES-256-GCM.
   */
  setChannelConfig(tenantId, key, value) {
    let row = queryOne("SELECT * FROM tenants WHERE id = $id", { $id: tenantId });
    let cfg;
    if (!row) {
      cfg = _defaultTenant(tenantId);
      run(
        `INSERT INTO tenants (id, config, created_at, last_seen_at, suspended, suspend_reason)
         VALUES ($id, $config, $created_at, $last_seen_at, 0, NULL)`,
        { $id: tenantId, $config: JSON.stringify(cfg), $created_at: cfg.createdAt, $last_seen_at: cfg.lastSeenAt }
      );
    } else {
      cfg = _parseConfig(row);
    }
    cfg.encryptedChannelConfig = cfg.encryptedChannelConfig || {};
    cfg.encryptedChannelConfig[key] = _encryptTenantValue(value);
    cfg.updatedAt = new Date().toISOString();
    _updateRow(tenantId, cfg);
    return true;
  }

  /**
   * Delete a per-tenant channel credential.
   */
  deleteChannelConfig(tenantId, key) {
    const row = queryOne("SELECT * FROM tenants WHERE id = $id", { $id: tenantId });
    if (!row) return false;
    const cfg = _parseConfig(row);
    if (!cfg.encryptedChannelConfig?.[key]) return false;
    delete cfg.encryptedChannelConfig[key];
    cfg.updatedAt = new Date().toISOString();
    _updateRow(tenantId, cfg);
    return true;
  }

  /**
   * List the credential keys stored for a tenant (not values).
   */
  listChannelConfigKeys(tenantId) {
    const row = queryOne("SELECT * FROM tenants WHERE id = $id", { $id: tenantId });
    if (!row) return [];
    const cfg = _parseConfig(row);
    return Object.keys(cfg.encryptedChannelConfig || {});
  }

  /**
   * Decrypt and return all channel credentials for a tenant.
   */
  getDecryptedChannelConfig(tenantId) {
    const row = queryOne("SELECT * FROM tenants WHERE id = $id", { $id: tenantId });
    if (!row) return {};
    const cfg = _parseConfig(row);
    const encrypted = cfg.encryptedChannelConfig || {};
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
   */
  setApiKey(tenantId, keyName, keyValue) {
    let row = queryOne("SELECT * FROM tenants WHERE id = $id", { $id: tenantId });
    let cfg;
    if (!row) {
      cfg = _defaultTenant(tenantId);
      run(
        `INSERT INTO tenants (id, config, created_at, last_seen_at, suspended, suspend_reason)
         VALUES ($id, $config, $created_at, $last_seen_at, 0, NULL)`,
        { $id: tenantId, $config: JSON.stringify(cfg), $created_at: cfg.createdAt, $last_seen_at: cfg.lastSeenAt }
      );
    } else {
      cfg = _parseConfig(row);
    }
    cfg.encryptedApiKeys = cfg.encryptedApiKeys || {};
    cfg.encryptedApiKeys[keyName] = _encryptTenantValue(keyValue);
    cfg.updatedAt = new Date().toISOString();
    _updateRow(tenantId, cfg);
    return true;
  }

  /**
   * Delete a per-tenant API key.
   */
  deleteApiKey(tenantId, keyName) {
    const row = queryOne("SELECT * FROM tenants WHERE id = $id", { $id: tenantId });
    if (!row) return false;
    const cfg = _parseConfig(row);
    if (!cfg.encryptedApiKeys?.[keyName]) return false;
    delete cfg.encryptedApiKeys[keyName];
    cfg.updatedAt = new Date().toISOString();
    _updateRow(tenantId, cfg);
    return true;
  }

  /**
   * List the names (not values) of stored API keys for a tenant.
   */
  listApiKeyNames(tenantId) {
    const row = queryOne("SELECT * FROM tenants WHERE id = $id", { $id: tenantId });
    if (!row) return [];
    const cfg = _parseConfig(row);
    return Object.keys(cfg.encryptedApiKeys || {});
  }

  /**
   * Decrypt and return all stored API keys for a tenant.
   */
  getDecryptedApiKeys(tenantId) {
    const row = queryOne("SELECT * FROM tenants WHERE id = $id", { $id: tenantId });
    if (!row) return {};
    const cfg = _parseConfig(row);
    const encrypted = cfg.encryptedApiKeys || {};
    const result = {};
    for (const [key, val] of Object.entries(encrypted)) {
      const decrypted = _decryptTenantValue(val);
      if (decrypted !== null) result[key] = decrypted;
    }
    return result;
  }

  // ── Per-Tenant MCP Servers ────────────────────────────────────────────────

  /**
   * Add a private MCP server to a tenant.
   * The server definition follows the same format as config/mcp.json entries.
   * Only this tenant can use servers defined here.
   */
  addOwnMcpServer(tenantId, name, serverConfig) {
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Server name must be alphanumeric (a-z, 0-9, _, -)");
    const row = queryOne("SELECT * FROM tenants WHERE id = $id", { $id: tenantId });
    if (!row) throw new Error(`Tenant "${tenantId}" not found`);
    const cfg = _parseConfig(row);
    cfg.ownMcpServers = cfg.ownMcpServers || {};
    cfg.ownMcpServers[name] = serverConfig;
    cfg.updatedAt = new Date().toISOString();
    _updateRow(tenantId, cfg);
    return { id: tenantId, name, serverConfig };
  }

  /**
   * Remove a private MCP server from a tenant.
   */
  removeOwnMcpServer(tenantId, name) {
    const row = queryOne("SELECT * FROM tenants WHERE id = $id", { $id: tenantId });
    if (!row) return false;
    const cfg = _parseConfig(row);
    if (!cfg.ownMcpServers?.[name]) return false;
    delete cfg.ownMcpServers[name];
    cfg.updatedAt = new Date().toISOString();
    _updateRow(tenantId, cfg);
    return true;
  }

  /**
   * Get all private MCP server definitions for a tenant (names + configs, no secrets).
   */
  getOwnMcpServers(tenantId) {
    const row = queryOne("SELECT * FROM tenants WHERE id = $id", { $id: tenantId });
    if (!row) return {};
    const cfg = _parseConfig(row);
    return cfg.ownMcpServers || {};
  }

  // ── Workspace ─────────────────────────────────────────────────────────────

  /**
   * Get (and create if missing) the isolated workspace directory for a tenant.
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
   * Path merging rules:
   *   - blockedPaths: union (global ∪ tenant) - tenant can add blocks, never remove global blocks
   *   - allowedPaths: intersection (tenant ∩ global) - tenant can narrow, never widen beyond global
   *   - Workspace: if sandbox enabled + no tenant allowed + no global allowed, lock to workspace
   */
  resolveTaskConfig(tenant, channelModel) {
    const sandboxEnabled = config.sandbox?.mode === "docker" || config.multiTenant?.isolateFilesystem;

    const globalAllowed = config.filesystem?.allowedPaths || [];
    const globalBlocked = config.filesystem?.blockedPaths || [];
    const tenantAllowed = tenant?.allowedPaths || [];
    const tenantBlocked = tenant?.blockedPaths || [];

    // ── Blocked: always union (global + tenant) - tenant can only add more blocks ──
    const mergedBlocked = [...new Set([...globalBlocked, ...tenantBlocked])];

    // ── Allowed: intersection logic - tenant can never exceed global ──
    let effectiveAllowed;
    if (globalAllowed.length > 0 && tenantAllowed.length > 0) {
      // Tenant paths must be inside a global allowed path (intersection)
      effectiveAllowed = tenantAllowed.filter((tp) => {
        const tpNorm = resolve(tp);
        return globalAllowed.some((gp) => {
          const gpNorm = resolve(gp);
          return tpNorm === gpNorm || tpNorm.startsWith(gpNorm + sep) || tpNorm.startsWith(gpNorm + "/");
        });
      });
    } else if (globalAllowed.length > 0) {
      // No tenant override → use global
      effectiveAllowed = globalAllowed;
    } else if (tenantAllowed.length > 0) {
      // No global restriction → tenant can scope itself
      effectiveAllowed = tenantAllowed;
    } else {
      effectiveAllowed = [];
    }

    // ── Workspace fallback: sandbox enabled + no allowed paths → lock to workspace ──
    // Global admin tenants are never sandboxed - they own the server
    if (sandboxEnabled && effectiveAllowed.length === 0 && tenant?.id && !tenant.globalAdmin) {
      effectiveAllowed = [this.getWorkspace(tenant.id)];
    }

    return {
      model: tenant?.model || channelModel || config.defaultModel || resolveDefaultModel(),
      allowedPaths: effectiveAllowed,
      blockedPaths: mergedBlocked,
      restrictCommands: config.filesystem?.restrictCommands || false,
      maxCostPerTask: tenant?.maxCostPerTask ?? config.maxCostPerTask,
      maxDailyCost: tenant?.maxDailyCost ?? config.maxDailyCost,
      tools: tenant?.tools || null,
      blockedTools: tenant?.blockedTools || null,
      sandbox: config.sandbox?.mode || "process",
      mcpServers: tenant?.mcpServers ?? null,
      ownMcpServers: tenant?.ownMcpServers || {},
      modelRoutes: tenant?.modelRoutes || null,
      apiKeys: tenant?.id ? this.getDecryptedApiKeys(tenant.id) : {},
      channelConfig: tenant?.id ? this.getDecryptedChannelConfig(tenant.id) : {},
    };
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  stats() {
    const all = this.list();
    return {
      total: all.length,
      suspended: all.filter(t => t.suspended).length,
      totalCost: all.reduce((s, t) => s + (t.totalCost || 0), 0).toFixed(4),
      totalTasks: all.reduce((s, t) => s + (t.taskCount || 0), 0),
    };
  }
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

function _makeId(channel, userId) {
  return `${channel}:${userId}`;
}

function _parseConfig(row) {
  try {
    return JSON.parse(row.config || "{}");
  } catch {
    return {};
  }
}

function _updateRow(tenantId, cfg) {
  run(
    `UPDATE tenants SET config = $config, last_seen_at = $last_seen_at,
     suspended = $suspended, suspend_reason = $suspend_reason
     WHERE id = $id`,
    {
      $id: tenantId,
      $config: JSON.stringify(cfg),
      $last_seen_at: cfg.lastSeenAt || null,
      $suspended: cfg.suspended ? 1 : 0,
      $suspend_reason: cfg.suspendReason || null,
    }
  );
}

function _defaultTenant(id) {
  return {
    model: null,
    allowedPaths: [],
    blockedPaths: [],
    maxCostPerTask: null,
    maxDailyCost: null,
    tools: null,
    blockedTools: null,     // blocklist of tools to hide from this tenant; null = none blocked
    mcpServers: null,       // allowlist of global MCP server names; null = all allowed
    ownMcpServers: {},      // per-tenant private MCP server definitions (same format as mcp.json entries)
    modelRoutes: null,
    encryptedApiKeys: {},
    encryptedChannelConfig: {},
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
