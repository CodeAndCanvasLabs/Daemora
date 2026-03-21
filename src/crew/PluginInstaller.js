/**
 * CrewInstaller — install/remove crew members from npm.
 *
 * Install: npm install <package> --prefix crew/<package-name>
 *   → creates crew/<name>/node_modules + plugin.json (from package)
 *   → discovered by CrewLoader on next load/reload
 *
 * Remove: deletes the crew member directory entirely.
 */

import { execSync } from "node:child_process";
import { existsSync, rmSync, readdirSync, readFileSync, writeFileSync, cpSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { config } from "../config/default.js";

const CREW_DIR = join(config.rootDir, "crew");

/**
 * Install a crew member from npm.
 * @param {string} pkg — npm package name (e.g. "daemora-plugin-weather" or "@scope/plugin")
 */
export async function installCrewMember(pkg) {
  if (!pkg) throw new Error("Package name required");

  // Derive crew member dir name from package
  const dirName = pkg.replace(/^@[^/]+\//, "").replace(/[^a-zA-Z0-9_-]/g, "-");
  const memberDir = join(CREW_DIR, dirName);

  if (existsSync(memberDir)) {
    console.log(`[CrewInstaller] Crew member directory already exists: ${dirName}`);
    console.log(`[CrewInstaller] Run "daemora crew remove ${dirName}" first to reinstall.`);
    return;
  }

  console.log(`[CrewInstaller] Installing ${pkg}...`);

  try {
    // Install npm package into the crew member directory
    execSync(`npm install ${pkg} --prefix "${memberDir}" --no-save --no-package-lock`, {
      stdio: "inherit",
      timeout: 120000,
    });

    // Find the actual package inside node_modules
    const nmDir = join(memberDir, "node_modules");
    const installed = _findInstalledPackage(nmDir, pkg);

    if (!installed) {
      throw new Error(`Package installed but could not find it in node_modules`);
    }

    // Check for plugin.json in the installed package
    const pluginJson = join(installed, "plugin.json");
    const packageJson = join(installed, "package.json");

    if (existsSync(pluginJson)) {
      // Has a plugin.json — copy files to crew member root
      _copyCrewFiles(installed, memberDir);
      console.log(`[CrewInstaller] ✓ Installed: ${dirName} (has plugin.json)`);
    } else if (existsSync(packageJson)) {
      // Check for daemora.plugin or openclaw.extensions in package.json
      const pkgMeta = JSON.parse(readFileSync(packageJson, "utf-8"));
      if (pkgMeta.daemora?.plugin || pkgMeta.daemora?.extensions) {
        _copyCrewFiles(installed, memberDir);
        // Generate plugin.json from package.json metadata
        _generatePluginJson(memberDir, pkgMeta);
        console.log(`[CrewInstaller] ✓ Installed: ${dirName} (from package.json metadata)`);
      } else {
        // No manifest — create a basic one
        _copyCrewFiles(installed, memberDir);
        _generatePluginJson(memberDir, pkgMeta);
        console.log(`[CrewInstaller] ✓ Installed: ${dirName} (generated plugin.json)`);
      }
    } else {
      throw new Error(`Package has no plugin.json or package.json`);
    }

    console.log(`[CrewInstaller] Restart server or run "daemora crew reload-all" to activate.`);
  } catch (e) {
    // Cleanup on failure
    if (existsSync(memberDir)) {
      try { rmSync(memberDir, { recursive: true, force: true }); } catch {}
    }
    console.error(`[CrewInstaller] ✗ Failed to install ${pkg}: ${e.message}`);
    throw e;
  }
}

/**
 * Remove an installed crew member.
 * @param {string} crewId — crew member directory name or ID
 */
export async function removeCrewMember(crewId) {
  // Find crew member dir — match by directory name or plugin.json id
  const memberDir = _findCrewMemberDir(crewId);
  if (!memberDir) {
    console.error(`[CrewInstaller] Crew member not found: ${crewId}`);
    return;
  }

  const dirName = basename(memberDir);
  rmSync(memberDir, { recursive: true, force: true });
  console.log(`[CrewInstaller] ✓ Removed: ${dirName}`);
  console.log(`[CrewInstaller] Restart server or run "daemora crew reload-all" to apply.`);
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

function _copyCrewFiles(srcDir, destDir) {
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

function _generatePluginJson(memberDir, pkgMeta) {
  const pluginJsonPath = join(memberDir, "plugin.json");
  if (existsSync(pluginJsonPath)) return; // Already has one

  const manifest = {
    id: pkgMeta.name?.replace(/^@[^/]+\//, "").replace(/[^a-zA-Z0-9_-]/g, "-") || "unknown",
    name: pkgMeta.name || "Unknown Crew Member",
    version: pkgMeta.version || "0.0.0",
    description: pkgMeta.description || "",
    provides: {},
  };

  // Auto-detect provides
  if (existsSync(join(memberDir, "tools"))) manifest.provides.tools = ["tools/*.js"];
  if (existsSync(join(memberDir, "skills"))) manifest.provides.skills = ["skills/*.md"];
  if (existsSync(join(memberDir, "profiles"))) manifest.provides.profiles = ["profiles/*.yaml"];

  writeFileSync(pluginJsonPath, JSON.stringify(manifest, null, 2));
}

function _findCrewMemberDir(crewId) {
  if (!existsSync(CREW_DIR)) return null;

  // Direct directory match
  const direct = join(CREW_DIR, crewId);
  if (existsSync(direct)) return direct;

  // Search by plugin.json id
  const entries = readdirSync(CREW_DIR, { withFileTypes: true }).filter(e => e.isDirectory());
  for (const entry of entries) {
    const manifestPath = join(CREW_DIR, entry.name, "plugin.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        if (manifest.id === crewId) return join(CREW_DIR, entry.name);
      } catch {}
    }
  }
  return null;
}
