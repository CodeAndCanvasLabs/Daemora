/**
 * PluginInstaller — install/remove plugins from npm.
 *
 * Install: npm install <package> --prefix plugins/<package-name>
 *   → creates plugins/<name>/node_modules + plugin.json (from package)
 *   → discovered by PluginLoader on next load/reload
 *
 * Remove: deletes the plugin directory entirely.
 */

import { execSync } from "node:child_process";
import { existsSync, rmSync, readdirSync, readFileSync, writeFileSync, cpSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { config } from "../config/default.js";

const PLUGINS_DIR = join(config.rootDir, "crew");

/**
 * Install a plugin from npm.
 * @param {string} pkg — npm package name (e.g. "daemora-plugin-weather" or "@scope/plugin")
 */
export async function installPlugin(pkg) {
  if (!pkg) throw new Error("Package name required");

  // Derive plugin dir name from package
  const dirName = pkg.replace(/^@[^/]+\//, "").replace(/[^a-zA-Z0-9_-]/g, "-");
  const pluginDir = join(PLUGINS_DIR, dirName);

  if (existsSync(pluginDir)) {
    console.log(`[PluginInstaller] Plugin directory already exists: ${dirName}`);
    console.log(`[PluginInstaller] Run "daemora plugin remove ${dirName}" first to reinstall.`);
    return;
  }

  console.log(`[PluginInstaller] Installing ${pkg}...`);

  try {
    // Install npm package into the plugin directory
    execSync(`npm install ${pkg} --prefix "${pluginDir}" --no-save --no-package-lock`, {
      stdio: "inherit",
      timeout: 120000,
    });

    // Find the actual package inside node_modules
    const nmDir = join(pluginDir, "node_modules");
    const installed = _findInstalledPackage(nmDir, pkg);

    if (!installed) {
      throw new Error(`Package installed but could not find it in node_modules`);
    }

    // Check for plugin.json in the installed package
    const pluginJson = join(installed, "plugin.json");
    const packageJson = join(installed, "package.json");

    if (existsSync(pluginJson)) {
      // Plugin has a plugin.json — copy files to plugin root
      _copyPluginFiles(installed, pluginDir);
      console.log(`[PluginInstaller] ✓ Installed: ${dirName} (has plugin.json)`);
    } else if (existsSync(packageJson)) {
      // Check for daemora.plugin or openclaw.extensions in package.json
      const pkgMeta = JSON.parse(readFileSync(packageJson, "utf-8"));
      if (pkgMeta.daemora?.plugin || pkgMeta.daemora?.extensions) {
        _copyPluginFiles(installed, pluginDir);
        // Generate plugin.json from package.json metadata
        _generatePluginJson(pluginDir, pkgMeta);
        console.log(`[PluginInstaller] ✓ Installed: ${dirName} (from package.json metadata)`);
      } else {
        // No plugin manifest — create a basic one
        _copyPluginFiles(installed, pluginDir);
        _generatePluginJson(pluginDir, pkgMeta);
        console.log(`[PluginInstaller] ✓ Installed: ${dirName} (generated plugin.json)`);
      }
    } else {
      throw new Error(`Package has no plugin.json or package.json`);
    }

    console.log(`[PluginInstaller] Restart server or run "daemora plugin reload-all" to activate.`);
  } catch (e) {
    // Cleanup on failure
    if (existsSync(pluginDir)) {
      try { rmSync(pluginDir, { recursive: true, force: true }); } catch {}
    }
    console.error(`[PluginInstaller] ✗ Failed to install ${pkg}: ${e.message}`);
    throw e;
  }
}

/**
 * Remove an installed plugin.
 * @param {string} pluginId — plugin directory name or ID
 */
export async function removePlugin(pluginId) {
  // Find plugin dir — match by directory name or plugin.json id
  const pluginDir = _findPluginDir(pluginId);
  if (!pluginDir) {
    console.error(`[PluginInstaller] Plugin not found: ${pluginId}`);
    return;
  }

  const dirName = basename(pluginDir);
  rmSync(pluginDir, { recursive: true, force: true });
  console.log(`[PluginInstaller] ✓ Removed: ${dirName}`);
  console.log(`[PluginInstaller] Restart server or run "daemora plugin reload-all" to apply.`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _findInstalledPackage(nmDir, pkg) {
  if (!existsSync(nmDir)) return null;

  // Handle scoped packages (@scope/name)
  if (pkg.startsWith("@")) {
    const [scope, name] = pkg.split("/");
    const scopeDir = join(nmDir, scope);
    const pkgDir = join(scopeDir, name);
    return existsSync(pkgDir) ? pkgDir : null;
  }

  const pkgDir = join(nmDir, pkg);
  return existsSync(pkgDir) ? pkgDir : null;
}

function _copyPluginFiles(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  const items = readdirSync(srcDir, { withFileTypes: true });
  for (const item of items) {
    if (item.name === "node_modules") continue;
    const src = join(srcDir, item.name);
    const dest = join(destDir, item.name);
    if (!existsSync(dest)) {
      cpSync(src, dest, { recursive: true });
    }
  }
}

function _generatePluginJson(pluginDir, pkgMeta) {
  const pluginJsonPath = join(pluginDir, "plugin.json");
  if (existsSync(pluginJsonPath)) return; // Already has one

  const manifest = {
    id: pkgMeta.name?.replace(/^@[^/]+\//, "").replace(/[^a-zA-Z0-9_-]/g, "-") || "unknown",
    name: pkgMeta.name || "Unknown Plugin",
    version: pkgMeta.version || "0.0.0",
    description: pkgMeta.description || "",
    provides: {},
  };

  // Auto-detect provides
  if (existsSync(join(pluginDir, "tools"))) manifest.provides.tools = ["tools/*.js"];
  if (existsSync(join(pluginDir, "skills"))) manifest.provides.skills = ["skills/*.md"];
  if (existsSync(join(pluginDir, "profiles"))) manifest.provides.profiles = ["profiles/*.yaml"];

  writeFileSync(pluginJsonPath, JSON.stringify(manifest, null, 2));
}

function _findPluginDir(pluginId) {
  if (!existsSync(PLUGINS_DIR)) return null;

  // Direct directory match
  const direct = join(PLUGINS_DIR, pluginId);
  if (existsSync(direct)) return direct;

  // Search by plugin.json id
  const entries = readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter(e => e.isDirectory());
  for (const entry of entries) {
    const manifestPath = join(PLUGINS_DIR, entry.name, "plugin.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        if (manifest.id === pluginId) return join(PLUGINS_DIR, entry.name);
      } catch {}
    }
  }
  return null;
}
