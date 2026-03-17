/**
 * PluginRegistry — global registry of loaded plugins and their registrations.
 *
 * Same pattern as OpenClaw's src/plugins/registry.ts:
 *   - Tracks all plugins + what they registered (tools, channels, hooks, services, CLI, routes)
 *   - PluginApi created per-plugin for isolated registration
 *   - Multi-tenant aware: tenantPlans filtering, per-tenant config/keys access
 */

import eventBus from "../core/EventBus.js";

// ── Registry State ──────────────────────────────────────────────────────────

const _registry = {
  plugins: [],        // PluginRecord[]
  tools: [],          // { pluginId, name, fn, schema, description }[]
  channels: [],       // { pluginId, name, impl }[]
  hooks: [],          // { pluginId, event, handler }[]
  services: [],       // { pluginId, id, start, stop }[]
  cliCommands: [],    // { pluginId, name, handler }[]
  httpRoutes: [],     // { pluginId, method, path, handler }[]
  diagnostics: [],    // { level, pluginId, message }[]
};

export function getRegistry() { return _registry; }

export function getPlugins() { return _registry.plugins; }
export function getPluginTools() { return _registry.tools; }
export function getPluginChannels() { return _registry.channels; }
export function getPluginServices() { return _registry.services; }
export function getPluginHooks() { return _registry.hooks; }
export function getPluginCliCommands() { return _registry.cliCommands; }
export function getPluginHttpRoutes() { return _registry.httpRoutes; }
export function getDiagnostics() { return _registry.diagnostics; }

export function getPlugin(id) {
  return _registry.plugins.find(p => p.id === id) || null;
}

/**
 * Get plugin tools filtered by tenant plan.
 * @param {string} [tenantPlan] — "free" | "pro" | "admin" | null (admin/global)
 */
export function getPluginToolsForPlan(tenantPlan) {
  if (!tenantPlan) return _registry.tools;
  return _registry.tools.filter(t => {
    const plugin = _registry.plugins.find(p => p.id === t.pluginId);
    if (!plugin?.tenantPlans) return true;
    return plugin.tenantPlans.includes(tenantPlan);
  });
}

/**
 * Get plugin tools filtered by agent scope.
 * @param {string} scope — "main" | "sub-agent" | "team"
 */
export function getPluginToolsForScope(scope) {
  return _registry.tools.filter(t => {
    const plugin = _registry.plugins.find(p => p.id === t.pluginId);
    if (!plugin?.agentScope) return true; // no restriction — available everywhere
    return plugin.agentScope.includes(scope);
  });
}

export function clearRegistry() {
  _registry.plugins.length = 0;
  _registry.tools.length = 0;
  _registry.channels.length = 0;
  _registry.hooks.length = 0;
  _registry.services.length = 0;
  _registry.cliCommands.length = 0;
  _registry.httpRoutes.length = 0;
  _registry.diagnostics.length = 0;
}

// ── Plugin Record ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} PluginRecord
 * @property {string} id
 * @property {string} name
 * @property {string} [version]
 * @property {string} [description]
 * @property {string} source — path to plugin dir
 * @property {boolean} enabled
 * @property {"loaded"|"disabled"|"error"} status
 * @property {string} [error]
 * @property {string[]} toolNames
 * @property {string[]} channelIds
 * @property {string[]} hookEvents
 * @property {string[]} serviceIds
 * @property {string[]} cliCommands
 * @property {number} httpRouteCount
 * @property {object} [manifest] — raw plugin.json
 * @property {string[]} [tenantPlans] — restrict to plans (free/pro/admin)
 * @property {object} [configSchema] — plugin config fields
 */

// ── Plugin API (passed to register()) ───────────────────────────────────────

/**
 * Create the API object passed to a plugin's register() function.
 * Same surface as OpenClaw's OpenClawPluginApi.
 */
export function createPluginApi(record, manifest, pluginDir) {
  const api = {
    id: record.id,
    name: record.name,
    version: record.version,
    source: record.source,

    // ── Tool registration ───────────────────────────────────────────────
    registerTool(name, fn, schema, description) {
      if (!name || typeof fn !== "function") {
        _diag("warn", record.id, `registerTool: invalid tool "${name}"`);
        return;
      }
      record.toolNames.push(name);
      _registry.tools.push({ pluginId: record.id, name, fn, schema: schema || null, description: description || "" });
    },

    // ── Channel registration ────────────────────────────────────────────
    registerChannel(name, impl) {
      if (!name || !impl) {
        _diag("warn", record.id, `registerChannel: invalid channel "${name}"`);
        return;
      }
      record.channelIds.push(name);
      _registry.channels.push({ pluginId: record.id, name, impl });
      // Wire into channelRegistry so it can instantiate this channel type
      try {
        import("../channels/index.js").then(mod => {
          mod.default.registerPluginChannel(name, impl);
        });
      } catch {}
    },

    // ── Lifecycle hooks ─────────────────────────────────────────────────
    on(event, handler) {
      if (!event || typeof handler !== "function") return;
      const events = Array.isArray(event) ? event : [event];
      for (const e of events) {
        record.hookEvents.push(e);
        _registry.hooks.push({ pluginId: record.id, event: e, handler });
        // Wire into EventBus
        eventBus.on(e, handler);
      }
    },

    // ── Services (background processes) ─────────────────────────────────
    registerService(service) {
      if (!service?.id) return;
      record.serviceIds.push(service.id);
      _registry.services.push({ pluginId: record.id, ...service });
    },

    // ── CLI commands ────────────────────────────────────────────────────
    registerCli(name, handler) {
      if (!name || typeof handler !== "function") return;
      record.cliCommands.push(name);
      _registry.cliCommands.push({ pluginId: record.id, name, handler });
    },

    // ── HTTP routes (prefixed /api/plugins/<pluginId>/...) ──────────────
    registerRoute(method, path, handler) {
      if (!method || !path || typeof handler !== "function") return;
      const fullPath = `/api/plugins/${record.id}${path.startsWith("/") ? path : "/" + path}`;
      record.httpRouteCount++;
      _registry.httpRoutes.push({ pluginId: record.id, method: method.toUpperCase(), path: fullPath, handler });
    },

    // ── Config access (plugin's own config) ─────────────────────────────
    config(key) {
      // Priority: process.env > SQLite config_entries > manifest defaults
      const envKey = `PLUGIN_${record.id.toUpperCase().replace(/-/g, "_")}_${key}`;
      if (process.env[envKey]) return process.env[envKey];
      // Check SQLite config_entries with plugin prefix (sync — configStore is already loaded)
      if (_configStore) {
        const val = _configStore.get(`plugin:${record.id}:${key}`);
        if (val) return val;
      }
      return manifest?.config?.[key]?.default || null;
    },

    // ── Set plugin config ───────────────────────────────────────────────
    setConfig(key, value) {
      try {
        import("../config/ConfigStore.js").then(mod => {
          mod.configStore.set(`plugin:${record.id}:${key}`, value);
        });
      } catch {}
    },

    // ── Tenant-aware access (Daemora-specific, not in OpenClaw) ─────────
    getTenantConfig(tenantId) {
      try {
        const tenantManager = _getTenantManager();
        return tenantManager.get(tenantId) || null;
      } catch { return null; }
    },

    getTenantKeys(tenantId) {
      try {
        const tenantManager = _getTenantManager();
        return tenantManager.getDecryptedApiKeys(tenantId) || {};
      } catch { return {}; }
    },

    // ── Logger ──────────────────────────────────────────────────────────
    log: {
      info: (msg) => console.log(`[Plugin:${record.id}] ${msg}`),
      warn: (msg) => console.log(`[Plugin:${record.id}] WARN: ${msg}`),
      error: (msg) => console.error(`[Plugin:${record.id}] ERROR: ${msg}`),
    },
  };

  return api;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _diag(level, pluginId, message) {
  _registry.diagnostics.push({ level, pluginId, message });
  if (level === "error") console.error(`[PluginRegistry] ${pluginId}: ${message}`);
  else console.log(`[PluginRegistry] ${pluginId}: ${message}`);
}

let _tenantManager = null;
async function _getTenantManager() {
  if (!_tenantManager) {
    const mod = await import("../tenants/TenantManager.js");
    _tenantManager = mod.default;
  }
  return _tenantManager;
}

let _configStore = null;
export async function initConfigStore() {
  try {
    const mod = await import("../config/ConfigStore.js");
    _configStore = mod.configStore;
  } catch {}
}
