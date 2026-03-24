/**
 * CrewLoader - discovers and loads crew members from crew/ directory.
 *
 * Same pattern as OpenClaw's src/plugins/loader.ts + discovery.ts:
 *   1. Scan crew/ dir for subdirectories with plugin.json
 *   2. Validate manifest (id, name, provides)
 *   3. Dynamic import entry point (index.js or register function)
 *   4. Call register(api) - crew member registers tools, channels, hooks, etc.
 *   5. Auto-load declarative provides (tools/*.js, skills/*.md, profiles/*.yaml)
 *   6. Store in global CrewRegistry
 *
 * Discovery order: crew/ dir → npm installed packages (future)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../config/default.js";
import {
  getRegistry,
  createCrewApi,
  clearRegistry,
  getCrewTools,
  getCrewServices,
  initConfigStore,
} from "./PluginRegistry.js";

let _loaded = false;

/**
 * Load all crew members from the crew/ directory.
 * Called once at startup, after core systems init.
 */
export async function loadCrew() {
  if (_loaded) return getRegistry();

  const crewDir = join(config.rootDir, "crew");
  if (!existsSync(crewDir)) {
    console.log("[CrewLoader] No crew/ directory - skipping");
    _loaded = true;
    return getRegistry();
  }

  const entries = readdirSync(crewDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
    .map(e => e.name);

  if (entries.length === 0) {
    console.log("[CrewLoader] No crew members found");
    _loaded = true;
    return getRegistry();
  }

  // Init configStore for crew config access
  await initConfigStore();

  console.log(`[CrewLoader] Discovering ${entries.length} crew member(s)...`);

  for (const dir of entries) {
    const memberDir = join(crewDir, dir);
    try {
      await _loadCrewMember(memberDir);
    } catch (e) {
      console.error(`[CrewLoader] Failed to load crew member "${dir}": ${e.message}`);
    }
  }

  // Start crew services
  for (const svc of getCrewServices()) {
    try {
      if (typeof svc.start === "function") await svc.start();
      console.log(`[CrewLoader] Service started: ${svc.id}`);
    } catch (e) {
      console.error(`[CrewLoader] Service "${svc.id}" failed to start: ${e.message}`);
    }
  }

  const registry = getRegistry();
  const toolCount = registry.tools.length;
  const channelCount = registry.channels.length;
  const hookCount = registry.hooks.length;
  const crewCount = registry.crew.filter(p => p.status === "loaded").length;

  console.log(`[CrewLoader] Loaded ${crewCount} crew member(s): ${toolCount} tools, ${channelCount} channels, ${hookCount} hooks`);

  _loaded = true;
  return registry;
}

/**
 * Reload all crew members (hot-reload).
 */
export async function reloadCrew() {
  // Stop services first
  for (const svc of getCrewServices()) {
    try {
      if (typeof svc.stop === "function") await svc.stop();
    } catch {}
  }

  clearRegistry();
  _loaded = false;
  return loadCrew();
}

/**
 * Reload a single crew member by ID.
 */
export async function reloadCrewMember(crewId) {
  const registry = getRegistry();
  const existing = registry.crew.find(p => p.id === crewId);
  if (!existing) throw new Error(`Crew member not found: ${crewId}`);

  // Stop its services
  for (const svc of registry.services.filter(s => s.crewId === crewId)) {
    try { if (typeof svc.stop === "function") await svc.stop(); } catch {}
  }

  // Remove all registrations for this crew member
  _unregisterCrewMember(crewId);

  // Re-load
  try {
    await _loadCrewMember(existing.source);
    // Re-start services
    for (const svc of registry.services.filter(s => s.crewId === crewId)) {
      try { if (typeof svc.start === "function") await svc.start(); } catch {}
    }
    console.log(`[CrewLoader] Reloaded: ${crewId}`);
  } catch (e) {
    console.error(`[CrewLoader] Reload failed for "${crewId}": ${e.message}`);
    throw e;
  }
}

/**
 * Stop all crew services (shutdown).
 */
export async function stopCrew() {
  for (const svc of getCrewServices()) {
    try {
      if (typeof svc.stop === "function") await svc.stop();
    } catch {}
  }
}

// ── Internal ────────────────────────────────────────────────────────────────

async function _loadCrewMember(memberDir) {
  const manifestPath = join(memberDir, "plugin.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing plugin.json in ${memberDir}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  if (!manifest.id || !manifest.name) {
    throw new Error(`plugin.json missing required fields (id, name) in ${memberDir}`);
  }

  // Skip templates - they're starter files for contributors, not real crew members
  if (manifest.template === true) {
    return;
  }

  // Check if disabled via config
  const enabled = _isCrewEnabled(manifest.id);

  // Build crew record
  const record = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version || null,
    description: manifest.description || null,
    source: memberDir,
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
    getRegistry().crew.push(record);
    console.log(`[CrewLoader] Skipped (disabled): ${manifest.id}`);
    return;
  }

  // Check required config - don't register tools if missing
  const configSchema = manifest.config || {};
  const missingKeys = [];
  let _cs = null;
  try { _cs = (await import("../config/ConfigStore.js")).configStore; } catch {}
  for (const [key, schema] of Object.entries(configSchema)) {
    if (!schema.required) continue;
    const val = process.env[key] || _cs?.get(`crew:${manifest.id}:${key}`) || null;
    if (!val) missingKeys.push(schema.label || key);
  }
  if (missingKeys.length > 0) {
    record.status = "needs-config";
    record.error = `Missing: ${missingKeys.join(", ")}`;
    record.enabled = false;
    getRegistry().crew.push(record);
    console.log(`[CrewLoader] Skipped (needs config): ${manifest.id} - ${record.error}`);
    return;
  }

  // Create crew API
  const api = createCrewApi(record, manifest, memberDir);

  // 1. Programmatic registration (index.js)
  const entryPath = join(memberDir, "index.js");
  if (existsSync(entryPath)) {
    try {
      // Cache-bust: append timestamp to force Node to re-import on reload
      const importUrl = `${pathToFileURL(entryPath).href}?t=${Date.now()}`;
      const mod = await import(importUrl);
      const member = mod.default || mod;

      if (typeof member === "function") {
        // Function export: export default function(api) { ... }
        await member(api);
      } else if (member && typeof member.register === "function") {
        // Object export: export default { id, name, register(api) { ... } }
        await member.register(api);
      }
    } catch (e) {
      record.status = "error";
      record.error = e.message;
      getRegistry().crew.push(record);
      throw e;
    }
  }

  // 2. Declarative auto-discovery (from provides in manifest)
  await _loadDeclarativeProvides(api, record, manifest, memberDir);

  // 3. Profile auto-append removed - crew members are self-contained sub-agents.
  // Main agent delegates via useCrew(crewId, task). Crew tools stay in registry.

  // 4. Store agentScope for filtering
  if (manifest.agentScope) {
    record.agentScope = manifest.agentScope;
  }

  getRegistry().crew.push(record);
  console.log(`[CrewLoader] Loaded: ${manifest.id} v${manifest.version || "0.0.0"} (${record.toolNames.length} tools, ${record.channelIds.length} channels)`);
}

/**
 * Auto-load tools, skills, profiles from manifest.provides globs.
 */
async function _loadDeclarativeProvides(api, record, manifest, memberDir) {
  const provides = manifest.provides || {};

  // Auto-load tools/*.js
  if (provides.tools) {
    const toolsDir = join(memberDir, "tools");
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
    const skillsDir = join(memberDir, "skills");
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
    const profilesDir = join(memberDir, "profiles");
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

function _unregisterCrewMember(crewId) {
  const registry = getRegistry();
  registry.tools = registry.tools.filter(t => t.crewId !== crewId);
  registry.channels = registry.channels.filter(c => c.crewId !== crewId);
  registry.hooks = registry.hooks.filter(h => h.crewId !== crewId);
  registry.services = registry.services.filter(s => s.crewId !== crewId);
  registry.cliCommands = registry.cliCommands.filter(c => c.crewId !== crewId);
  registry.httpRoutes = registry.httpRoutes.filter(r => r.crewId !== crewId);
  registry.crew = registry.crew.filter(p => p.id !== crewId);
}

function _isCrewEnabled(crewId) {
  // Check config_entries for crew:<id>:enabled
  try {
    const env = process.env[`CREW_${crewId.toUpperCase().replace(/-/g, "_")}_ENABLED`];
    if (env === "false") return false;
    if (env === "true") return true;
  } catch {}
  return true; // enabled by default
}
