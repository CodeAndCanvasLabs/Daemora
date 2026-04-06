/**
 * ProfileLoader - reads agent profiles from YAML files.
 *
 * Profiles define: identity (systemPrompt), tools, skill scoping, temperature, model.
 * Built-in profiles ship in src/config/profiles/*.yaml.
 * Custom overrides: data/profiles/*.yaml (loaded on top).
 *
 * Open-source friendly - contributors add profiles via PR (drop a YAML file).
 */

import { join, basename } from "path";
import { readdirSync, readFileSync, existsSync } from "fs";
import { config } from "./default.js";
import { getRegistry } from "../crew/PluginRegistry.js";

// ── YAML parser (no dependency - profiles are simple key-value) ──────────────
// Handles: scalars, arrays, multi-line strings (|), nested objects (1 level)

function parseYaml(text) {
  const result = {};
  let currentKey = null;
  let multiLineKey = null;
  let multiLineIndent = null;
  let multiLineValue = [];

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip comments and empty lines (unless in multi-line mode)
    if (!multiLineKey && (line.trim() === "" || line.trim().startsWith("#"))) continue;

    // Multi-line string collection (| block scalar)
    if (multiLineKey) {
      const indent = line.search(/\S/);
      if (indent === -1) {
        // Empty line inside multi-line - preserve
        multiLineValue.push("");
        continue;
      }
      if (indent >= multiLineIndent) {
        multiLineValue.push(line.slice(multiLineIndent));
        continue;
      }
      // Dedent - end multi-line block
      result[multiLineKey] = multiLineValue.join("\n").trimEnd();
      multiLineKey = null;
      multiLineIndent = null;
      multiLineValue = [];
      // Fall through to process this line normally
    }

    // Key: value pair
    const kvMatch = line.match(/^(\w[\w.-]*)\s*:\s*(.*)/);
    if (kvMatch) {
      const [, key, rawValue] = kvMatch;
      const value = rawValue.trim();
      currentKey = key;

      if (value === "|") {
        // Start multi-line block
        multiLineKey = key;
        multiLineIndent = (lines[i + 1] || "").search(/\S/);
        if (multiLineIndent <= 0) multiLineIndent = 2;
        multiLineValue = [];
      } else if (value === "" || value === "[]") {
        // Empty or explicit empty array
        result[key] = value === "[]" ? [] : null;
      } else if (value === "null") {
        result[key] = null;
      } else if (value === "true") {
        result[key] = true;
      } else if (value === "false") {
        result[key] = false;
      } else if (/^-?\d+(\.\d+)?$/.test(value)) {
        result[key] = parseFloat(value);
      } else if (value.startsWith("[") && value.endsWith("]")) {
        // Inline array: [a, b, c]
        result[key] = value.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
      } else if (value.startsWith("{") && value.endsWith("}")) {
        // Inline object - skip, not needed for profiles
        result[key] = {};
      } else {
        result[key] = value;
      }
    } else if (line.match(/^\s+-\s+(.+)/)) {
      // Array item under current key
      const itemMatch = line.match(/^\s+-\s+(.+)/);
      if (itemMatch && currentKey) {
        if (!Array.isArray(result[currentKey])) result[currentKey] = [];
        result[currentKey].push(itemMatch[1].trim());
      }
    } else if (line.match(/^\s+(\w[\w.-]*)\s*:\s*(.*)/)) {
      // Nested key (1 level) - for skills.include, skills.exclude
      const nestedMatch = line.match(/^\s+(\w[\w.-]*)\s*:\s*(.*)/);
      if (nestedMatch && currentKey) {
        if (!result[currentKey] || typeof result[currentKey] !== "object" || Array.isArray(result[currentKey])) {
          result[currentKey] = {};
        }
        const nestedValue = nestedMatch[2].trim();
        if (nestedValue.startsWith("[") && nestedValue.endsWith("]")) {
          result[currentKey][nestedMatch[1]] = nestedValue.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
        } else {
          result[currentKey][nestedMatch[1]] = nestedValue || null;
        }
      }
    }
  }

  // Flush any remaining multi-line
  if (multiLineKey) {
    result[multiLineKey] = multiLineValue.join("\n").trimEnd();
  }

  return result;
}

// ── Profile cache ────────────────────────────────────────────────────────────

const profileCache = new Map(); // id → profile
let cacheLoaded = false;

const BUILTIN_DIR = new URL("./profiles", import.meta.url).pathname;

function loadProfilesFromDir(dir, isBuiltin = false) {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const parsed = parseYaml(raw);
      if (!parsed.id) {
        parsed.id = basename(file, file.endsWith(".yaml") ? ".yaml" : ".yml");
      }
      // Validate required fields
      if (!parsed.name) {
        console.warn(`[ProfileLoader] Skipping ${file}: missing 'name' field`);
        continue;
      }
      // Skip if already loaded from crew (crew takes priority)
      if (profileCache.has(parsed.id)) continue;
      profileCache.set(parsed.id, {
        id: parsed.id,
        name: parsed.name || parsed.id,
        description: parsed.description || "",
        systemPrompt: parsed.systemPrompt || "",
        temperature: parsed.temperature ?? null,
        model: parsed.model || null,
        tools: Array.isArray(parsed.tools) ? parsed.tools : [],
        skills: parsed.skills || null,  // { include: [], exclude: [] }
        capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : [],
        isBuiltin,
        source: join(dir, file),
      });
    } catch (e) {
      console.warn(`[ProfileLoader] Error loading ${file}: ${e.message}`);
    }
  }
}

function ensureLoaded() {
  if (cacheLoaded) return;
  cacheLoaded = true;

  // 1. Crew-based profiles (new source of truth - crew/*/plugin.json)
  _loadFromCrewRegistry();

  // 2. Legacy YAML profiles (fallback - src/config/profiles/*.yaml)
  // Only loads profiles NOT already loaded from crew (crew takes priority)
  loadProfilesFromDir(BUILTIN_DIR, true);

  // 3. User custom profiles (data dir)
  const customDir = join(config.dataDir, "profiles");
  loadProfilesFromDir(customDir, false);

  console.log(`[ProfileLoader] Loaded ${profileCache.size} profiles (crew + YAML)`);
}

/**
 * Load profiles from crew registry (plugin.json manifests).
 * Each crew member with a profile section becomes a profile.
 * Format: plugin.json { id, name, description, profile: { systemPrompt, temperature, model }, tools, skills, capabilities }
 */
function _loadFromCrewRegistry() {
  try {
    const registry = getRegistry();
    if (!registry?.crew) return;

    for (const member of registry.crew) {
      if (!member.manifest?.profile) continue;
      if (profileCache.has(member.id)) continue; // don't override existing

      const m = member.manifest;
      const skills = {};
      if (m.skills?.length) skills.include = m.skills;
      if (m.skillsExclude?.length) skills.exclude = m.skillsExclude;

      profileCache.set(member.id, {
        id: member.id,
        name: m.name || member.id,
        description: m.description || "",
        systemPrompt: m.profile.systemPrompt || "",
        temperature: m.profile.temperature ?? null,
        model: m.profile.model || null,
        tools: Array.isArray(m.tools) ? m.tools : [],
        skills: Object.keys(skills).length > 0 ? skills : null,
        capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
        isBuiltin: false,
        source: `crew/${member.id}/plugin.json`,
      });
    }
  } catch {
    // Crew registry not loaded yet - will use YAML fallback
  }
}


// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get profile by ID. Priority: custom (data/) → built-in.
 */
export function getProfile(id) {
  ensureLoaded();
  const profile = profileCache.get(id);
  return profile ? { ...profile } : null;
}

/**
 * List all available profiles.
 */
export function listProfiles() {
  ensureLoaded();
  return [...profileCache.values()];
}

/**
 * Get profile IDs that match a capability.
 */
export function getProfilesByCapability(capability) {
  ensureLoaded();
  return [...profileCache.values()].filter(p =>
    p.capabilities.includes(capability)
  );
}

/**
 * Reload profiles from disk (for hot-reload).
 */
export function reloadProfiles() {
  cacheLoaded = false;
  profileCache.clear();
  ensureLoaded();
}

/**
 * Get the default tool list for sub-agents without a profile.
 */
export { defaultSubAgentTools } from "./agentProfiles.js";
