/**
 * PluginLoader — discovers and loads plugins from plugins/ directory.
 *
 * Same pattern as OpenClaw's src/plugins/loader.ts + discovery.ts:
 *   1. Scan plugins/ dir for subdirectories with plugin.json
 *   2. Validate manifest (id, name, provides)
 *   3. Dynamic import entry point (index.js or register function)
 *   4. Call register(api) — plugin registers tools, channels, hooks, etc.
 *   5. Auto-load declarative provides (tools/*.js, skills/*.md, profiles/*.yaml)
 *   6. Store in global PluginRegistry
 *
 * Discovery order: plugins/ dir → npm installed packages (future)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../config/default.js";
import {
  getRegistry,
  createPluginApi,
  clearRegistry,
  getPluginTools,
  getPluginServices,
  initConfigStore,
} from "./PluginRegistry.js";

let _loaded = false;

/**
 * Load all plugins from the plugins/ directory.
 * Called once at startup, after core systems init.
 */
export async function loadPlugins() {
  if (_loaded) return getRegistry();

  const pluginsDir = join(config.rootDir, "crew");
  if (!existsSync(pluginsDir)) {
    console.log("[CrewLoader] No crew/ directory — skipping");
    _loaded = true;
    return getRegistry();
  }

  const entries = readdirSync(pluginsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  if (entries.length === 0) {
    console.log("[PluginLoader] No plugins found");
    _loaded = true;
    return getRegistry();
  }

  // Init configStore for plugin config access
  await initConfigStore();

  console.log(`[PluginLoader] Discovering ${entries.length} plugin(s)...`);

  for (const dir of entries) {
    const pluginDir = join(pluginsDir, dir);
    try {
      await _loadPlugin(pluginDir);
    } catch (e) {
      console.error(`[PluginLoader] Failed to load plugin "${dir}": ${e.message}`);
    }
  }

  // Start plugin services
  for (const svc of getPluginServices()) {
    try {
      if (typeof svc.start === "function") await svc.start();
      console.log(`[PluginLoader] Service started: ${svc.id}`);
    } catch (e) {
      console.error(`[PluginLoader] Service "${svc.id}" failed to start: ${e.message}`);
    }
  }

  const registry = getRegistry();
  const toolCount = registry.tools.length;
  const channelCount = registry.channels.length;
  const hookCount = registry.hooks.length;
  const pluginCount = registry.plugins.filter(p => p.status === "loaded").length;

  console.log(`[PluginLoader] Loaded ${pluginCount} plugin(s): ${toolCount} tools, ${channelCount} channels, ${hookCount} hooks`);

  _loaded = true;
  return registry;
}

/**
 * Reload all plugins (hot-reload).
 */
export async function reloadPlugins() {
  // Stop services first
  for (const svc of getPluginServices()) {
    try {
      if (typeof svc.stop === "function") await svc.stop();
    } catch {}
  }

  clearRegistry();
  _loaded = false;
  return loadPlugins();
}

/**
 * Reload a single plugin by ID.
 */
export async function reloadPlugin(pluginId) {
  const registry = getRegistry();
  const existing = registry.plugins.find(p => p.id === pluginId);
  if (!existing) throw new Error(`Plugin not found: ${pluginId}`);

  // Stop its services
  for (const svc of registry.services.filter(s => s.pluginId === pluginId)) {
    try { if (typeof svc.stop === "function") await svc.stop(); } catch {}
  }

  // Remove all registrations for this plugin
  _unregisterPlugin(pluginId);

  // Re-load
  try {
    await _loadPlugin(existing.source);
    // Re-start services
    for (const svc of registry.services.filter(s => s.pluginId === pluginId)) {
      try { if (typeof svc.start === "function") await svc.start(); } catch {}
    }
    console.log(`[PluginLoader] Reloaded: ${pluginId}`);
  } catch (e) {
    console.error(`[PluginLoader] Reload failed for "${pluginId}": ${e.message}`);
    throw e;
  }
}

/**
 * Stop all plugin services (shutdown).
 */
export async function stopPlugins() {
  for (const svc of getPluginServices()) {
    try {
      if (typeof svc.stop === "function") await svc.stop();
    } catch {}
  }
}

// ── Internal ────────────────────────────────────────────────────────────────

async function _loadPlugin(pluginDir) {
  const manifestPath = join(pluginDir, "plugin.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing plugin.json in ${pluginDir}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  if (!manifest.id || !manifest.name) {
    throw new Error(`plugin.json missing required fields (id, name) in ${pluginDir}`);
  }

  // Check if disabled via config
  const enabled = _isPluginEnabled(manifest.id);

  // Build plugin record
  const record = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version || null,
    description: manifest.description || null,
    source: pluginDir,
    enabled,
    status: enabled ? "loaded" : "disabled",
    error: null,
    toolNames: [],
    channelIds: [],
    hookEvents: [],
    serviceIds: [],
    cliCommands: [],
    httpRouteCount: 0,
    manifest,
    tenantPlans: manifest.tenantPlans || null,
    configSchema: manifest.config || null,
  };

  if (!enabled) {
    getRegistry().plugins.push(record);
    console.log(`[PluginLoader] Skipped (disabled): ${manifest.id}`);
    return;
  }

  // Check required config — don't register tools if missing
  const configSchema = manifest.config || {};
  const missingKeys = [];
  let _cs = null;
  try { _cs = (await import("../config/ConfigStore.js")).configStore; } catch {}
  for (const [key, schema] of Object.entries(configSchema)) {
    if (!schema.required) continue;
    const val = process.env[key] || _cs?.get(`plugin:${manifest.id}:${key}`) || null;
    if (!val) missingKeys.push(schema.label || key);
  }
  if (missingKeys.length > 0) {
    record.status = "needs-config";
    record.error = `Missing: ${missingKeys.join(", ")}`;
    record.enabled = false;
    getRegistry().plugins.push(record);
    console.log(`[PluginLoader] Skipped (needs config): ${manifest.id} — ${record.error}`);
    return;
  }

  // Create plugin API
  const api = createPluginApi(record, manifest, pluginDir);

  // 1. Programmatic registration (index.js)
  const entryPath = join(pluginDir, "index.js");
  if (existsSync(entryPath)) {
    try {
      // Cache-bust: append timestamp to force Node to re-import on reload
      const importUrl = `${pathToFileURL(entryPath).href}?t=${Date.now()}`;
      const mod = await import(importUrl);
      const plugin = mod.default || mod;

      if (typeof plugin === "function") {
        // Function export: export default function(api) { ... }
        await plugin(api);
      } else if (plugin && typeof plugin.register === "function") {
        // Object export: export default { id, name, register(api) { ... } }
        await plugin.register(api);
      }
    } catch (e) {
      record.status = "error";
      record.error = e.message;
      getRegistry().plugins.push(record);
      throw e;
    }
  }

  // 2. Declarative auto-discovery (from provides in manifest)
  await _loadDeclarativeProvides(api, record, manifest, pluginDir);

  // 3. Profile auto-append removed — crew members are self-contained sub-agents.
  // Main agent delegates via useCrew(crewId, task). Crew tools stay in registry.

  // 4. Store agentScope for filtering
  if (manifest.agentScope) {
    record.agentScope = manifest.agentScope;
  }

  getRegistry().plugins.push(record);
  console.log(`[PluginLoader] Loaded: ${manifest.id} v${manifest.version || "0.0.0"} (${record.toolNames.length} tools, ${record.channelIds.length} channels)`);
}

/**
 * Auto-load tools, skills, profiles from manifest.provides globs.
 */
async function _loadDeclarativeProvides(api, record, manifest, pluginDir) {
  const provides = manifest.provides || {};

  // Auto-load tools/*.js
  if (provides.tools) {
    const toolsDir = join(pluginDir, "tools");
    if (existsSync(toolsDir)) {
      const files = readdirSync(toolsDir).filter(f => f.endsWith(".js"));
      for (const file of files) {
        try {
          const mod = await import(`${pathToFileURL(join(toolsDir, file)).href}?t=${Date.now()}`);
          const toolName = file.replace(".js", "");
          if (mod.default && typeof mod.default === "function") {
            api.registerTool(toolName, mod.default, mod.schema || null, mod.description || "");
          } else if (mod[toolName] && typeof mod[toolName] === "function") {
            api.registerTool(toolName, mod[toolName], mod[`${toolName}Schema`] || null, mod[`${toolName}Description`] || "");
          }
        } catch (e) {
          api.log.error(`Failed to load tool ${file}: ${e.message}`);
        }
      }
    }
  }

  // Auto-load skills/*.md
  if (provides.skills) {
    const skillsDir = join(pluginDir, "skills");
    if (existsSync(skillsDir)) {
      try {
        const skillLoader = (await import("../skills/SkillLoader.js")).default;
        skillLoader.loadFromDir(skillsDir);
      } catch (e) {
        api.log.warn(`Failed to load skills: ${e.message}`);
      }
    }
  }

  // Auto-load profiles/*.yaml
  if (provides.profiles) {
    const profilesDir = join(pluginDir, "profiles");
    if (existsSync(profilesDir)) {
      try {
        const { loadProfilesFromDir } = await import("../config/agentProfiles.js");
        if (typeof loadProfilesFromDir === "function") {
          loadProfilesFromDir(profilesDir);
        }
      } catch (e) {
        api.log.warn(`Failed to load profiles: ${e.message}`);
      }
    }
  }
}

function _unregisterPlugin(pluginId) {
  const registry = getRegistry();
  registry.tools = registry.tools.filter(t => t.pluginId !== pluginId);
  registry.channels = registry.channels.filter(c => c.pluginId !== pluginId);
  registry.hooks = registry.hooks.filter(h => h.pluginId !== pluginId);
  registry.services = registry.services.filter(s => s.pluginId !== pluginId);
  registry.cliCommands = registry.cliCommands.filter(c => c.pluginId !== pluginId);
  registry.httpRoutes = registry.httpRoutes.filter(r => r.pluginId !== pluginId);
  registry.plugins = registry.plugins.filter(p => p.id !== pluginId);
}

function _isPluginEnabled(pluginId) {
  // Check config_entries for plugin:<id>:enabled
  try {
    const env = process.env[`PLUGIN_${pluginId.toUpperCase().replace(/-/g, "_")}_ENABLED`];
    if (env === "false") return false;
    if (env === "true") return true;
  } catch {}
  return true; // enabled by default
}
