/**
 * CrewRegistry - global registry of loaded crew members and their registrations.
 *
 * Same pattern as OpenClaw's src/plugins/registry.ts:
 *   - Tracks all crew members + what they registered (tools, channels, hooks, services, CLI, routes)
 *   - CrewApi created per-member for isolated registration
 *   - Multi-tenant aware: tenantPlans filtering, per-tenant config/keys access
 */

import eventBus from "../core/EventBus.js";
import requestContext from "../core/RequestContext.js";

// ── Registry State ──────────────────────────────────────────────────────────

const _registry = {
  crew: [],             // CrewRecord[]
  tools: [],            // { crewId, name, fn, schema, description }[]
  channels: [],         // { crewId, name, impl }[]
  hooks: [],            // { crewId, event, handler }[]
  services: [],         // { crewId, id, start, stop }[]
  cliCommands: [],      // { crewId, name, handler }[]
  httpRoutes: [],       // { crewId, method, path, handler }[]
  diagnostics: [],      // { level, crewId, message }[]
};

export function getRegistry() { return _registry; }

export function getCrew() { return _registry.crew; }
export function getCrewTools() { return _registry.tools; }
export function getCrewChannels() { return _registry.channels; }
export function getCrewServices() { return _registry.services; }
export function getCrewHooks() { return _registry.hooks; }
export function getCrewCliCommands() { return _registry.cliCommands; }
export function getCrewHttpRoutes() { return _registry.httpRoutes; }
export function getDiagnostics() { return _registry.diagnostics; }

export function getCrewMember(id) {
  return _registry.crew.find(p => p.id === id) || null;
}

/**
 * Get crew tools filtered by tenant plan.
 * @param {string} [tenantPlan] - "free" | "pro" | "admin" | null (admin/global)
 */
export function getCrewToolsForPlan(tenantPlan) {
  if (!tenantPlan) return _registry.tools;
  return _registry.tools.filter(t => {
    const member = _registry.crew.find(p => p.id === t.crewId);
    if (!member?.tenantPlans) return true;
    return member.tenantPlans.includes(tenantPlan);
  });
}

/**
 * Get crew tools filtered by agent scope.
 * @param {string} scope - "main" | "sub-agent" | "team"
 */
export function getCrewToolsForScope(scope) {
  return _registry.tools.filter(t => {
    const member = _registry.crew.find(p => p.id === t.crewId);
    if (!member?.agentScope) return true; // no restriction - available everywhere
    return member.agentScope.includes(scope);
  });
}

export function clearRegistry() {
  _registry.crew.length = 0;
  _registry.tools.length = 0;
  _registry.channels.length = 0;
  _registry.hooks.length = 0;
  _registry.services.length = 0;
  _registry.cliCommands.length = 0;
  _registry.httpRoutes.length = 0;
  _registry.diagnostics.length = 0;
}

// ── Crew Record ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CrewRecord
 * @property {string} id
 * @property {string} name
 * @property {string} [version]
 * @property {string} [description]
 * @property {string} source - path to crew member dir
 * @property {boolean} enabled
 * @property {"loaded"|"disabled"|"error"} status
 * @property {string} [error]
 * @property {string[]} toolNames
 * @property {string[]} channelIds
 * @property {string[]} hookEvents
 * @property {string[]} serviceIds
 * @property {string[]} cliCommands
 * @property {number} httpRouteCount
 * @property {object} [manifest] - raw plugin.json
 * @property {string[]} [tenantPlans] - restrict to plans (free/pro/admin)
 * @property {object} [configSchema] - crew config fields
 */

// ── Crew API (passed to register()) ─────────────────────────────────────────

/**
 * Create the API object passed to a crew member's register() function.
 * Same surface as OpenClaw's OpenClawPluginApi.
 */
export function createCrewApi(record, manifest, memberDir) {
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
      _registry.tools.push({ crewId: record.id, name, fn, schema: schema || null, description: description || "" });
    },

    // ── Channel registration ────────────────────────────────────────────
    registerChannel(name, impl) {
      if (!name || !impl) {
        _diag("warn", record.id, `registerChannel: invalid channel "${name}"`);
        return;
      }
      record.channelIds.push(name);
      _registry.channels.push({ crewId: record.id, name, impl });
      // Wire into channelRegistry so it can instantiate this channel type
      try {
        import("../channels/index.js").then(mod => {
          mod.default.registerCrewChannel(name, impl);
        });
      } catch {}
    },

    // ── Lifecycle hooks ─────────────────────────────────────────────────
    on(event, handler) {
      if (!event || typeof handler !== "function") return;
      const events = Array.isArray(event) ? event : [event];
      for (const e of events) {
        record.hookEvents.push(e);
        _registry.hooks.push({ crewId: record.id, event: e, handler });
        // Wire into EventBus
        eventBus.on(e, handler);
      }
    },

    // ── Services (background processes) ─────────────────────────────────
    registerService(service) {
      if (!service?.id) return;
      record.serviceIds.push(service.id);
      _registry.services.push({ crewId: record.id, ...service });
    },

    // ── CLI commands ────────────────────────────────────────────────────
    registerCli(name, handler) {
      if (!name || typeof handler !== "function") return;
      record.cliCommands.push(name);
      _registry.cliCommands.push({ crewId: record.id, name, handler });
    },

    // ── HTTP routes (prefixed /api/crew/<crewId>/...) ───────────────────
    registerRoute(method, path, handler) {
      if (!method || !path || typeof handler !== "function") return;
      const fullPath = `/api/crew/${record.id}${path.startsWith("/") ? path : "/" + path}`;
      record.httpRouteCount++;
      _registry.httpRoutes.push({ crewId: record.id, method: method.toUpperCase(), path: fullPath, handler });
    },

    // ── Config access (crew member's own config) ────────────────────────
    config(key) {
      // Priority: process.env > SQLite config_entries > manifest defaults
      const envKey = `CREW_${record.id.toUpperCase().replace(/-/g, "_")}_${key}`;
      if (process.env[envKey]) return process.env[envKey];
      // Check SQLite config_entries with crew prefix (sync - configStore is already loaded)
      if (_configStore) {
        const val = _configStore.get(`crew:${record.id}:${key}`);
        if (val) return val;
      }
      return manifest?.config?.[key]?.default || null;
    },

    // ── Set crew config ─────────────────────────────────────────────────
    setConfig(key, value) {
      try {
        import("../config/ConfigStore.js").then(mod => {
          mod.configStore.set(`crew:${record.id}:${key}`, value);
        });
      } catch {}
    },

    // ── Request context access ──────────────────────────────────────────
    getRequestStore() {
      return requestContext.getStore() || {};
    },

    getApiKeys() {
      return requestContext.getStore()?.apiKeys || {};
    },

    // ── Logger ──────────────────────────────────────────────────────────
    log: {
      info: (msg) => console.log(`[Crew:${record.id}] ${msg}`),
      warn: (msg) => console.log(`[Crew:${record.id}] WARN: ${msg}`),
      error: (msg) => console.error(`[Crew:${record.id}] ERROR: ${msg}`),
    },
  };

  return api;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _diag(level, crewId, message) {
  _registry.diagnostics.push({ level, crewId, message });
  if (level === "error") console.error(`[CrewRegistry] ${crewId}: ${message}`);
  else console.log(`[CrewRegistry] ${crewId}: ${message}`);
}

let _configStore = null;
export async function initConfigStore() {
  try {
    const mod = await import("../config/ConfigStore.js");
    _configStore = mod.configStore;
  } catch {}
}
