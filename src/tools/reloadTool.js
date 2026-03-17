/**
 * reload(action) - Hot-reload system components without restart.
 *
 * Actions:
 *   all       - reload everything (config, models, skills, mcp, scheduler, channels, vault, caches)
 *   config    - reload config from SQLite + vault
 *   models    - clear provider cache + re-resolve default model
 *   skills    - reload skill files + re-embed
 *   mcp       - reload all MCP server connections
 *   scheduler - reload cron jobs from DB (stop + restart timers)
 *   channels  - reconnect all active channels
 *   vault     - reload secrets from DB (if unlocked)
 *   caches    - clear web fetch + search caches
 *   status    - show what's currently loaded and reloadable
 */
import { config, reloadFromDb } from "../config/default.js";
import { resolveDefaultModel, clearProviderCache } from "../models/ModelRouter.js";
import skillLoader from "../skills/SkillLoader.js";
import mcpManager from "../mcp/MCPManager.js";
import scheduler from "../scheduler/Scheduler.js";
import channelRegistry from "../channels/index.js";
import secretVault from "../safety/SecretVault.js";
import { clearFetchCache } from "./webFetch.js";
import { clearSearchCache } from "./webSearch.js";
import eventBus from "../core/EventBus.js";

async function _reloadConfig() {
  await reloadFromDb();
  // Re-resolve default model if not explicitly set
  if (!process.env.DEFAULT_MODEL) {
    config.defaultModel = resolveDefaultModel();
  }
  return { config: "reloaded", defaultModel: config.defaultModel };
}

function _reloadModels() {
  clearProviderCache();
  const prev = config.defaultModel;
  config.defaultModel = resolveDefaultModel();
  return { previous: prev, current: config.defaultModel };
}

async function _reloadSkills() {
  skillLoader.reload();
  const count = skillLoader.list().length;
  // Re-embed in background (non-blocking)
  skillLoader.embedSkills().catch(() => {});
  return { skills: count };
}

async function _reloadMCP() {
  const servers = mcpManager.list ? mcpManager.list() : [];
  let reloaded = 0;
  for (const server of servers) {
    try {
      await mcpManager.reloadServer(server.name || server);
      reloaded++;
    } catch (e) {
      console.log(`[reload] MCP server "${server.name || server}" reload failed: ${e.message}`);
    }
  }
  return { mcpServers: reloaded };
}

async function _reloadScheduler() {
  scheduler.stop();
  await scheduler.start();
  const status = scheduler.status();
  return { jobs: status.totalJobs, running: status.runningJobs };
}

async function _reloadChannels() {
  let restarted = 0;
  try {
    await channelRegistry.stopAll();
    await channelRegistry.startAll();
    restarted = channelRegistry.channels ? channelRegistry.channels.size : -1;
  } catch (e) {
    return { channels: "error", error: e.message };
  }
  return { channels: restarted };
}

function _reloadVault() {
  if (!secretVault.isUnlocked()) return { vault: "locked (skipped)" };
  // Re-inject vault secrets into process.env so providers pick up new keys
  const secrets = secretVault.getAsEnv();
  let injected = 0;
  for (const [key, value] of Object.entries(secrets)) {
    process.env[key] = value;
    injected++;
  }
  return { vault: "reloaded", secrets: injected };
}

function _clearCaches() {
  clearFetchCache();
  clearSearchCache();
  return { caches: "cleared" };
}

export async function reload(toolParams) {
  const action = toolParams?.action || "all";

  try {
    switch (action) {
      case "status": {
        const skills = skillLoader.list();
        const schedulerStatus = scheduler.status();
        const mcpServers = mcpManager.list ? mcpManager.list() : [];
        return JSON.stringify({
          defaultModel: config.defaultModel,
          vault: secretVault.isUnlocked() ? "unlocked" : "locked",
          skills: skills.length,
          mcpServers: mcpServers.length,
          scheduler: {
            totalJobs: schedulerStatus.totalJobs,
            runningJobs: schedulerStatus.runningJobs,
            started: schedulerStatus.started,
          },
          reloadable: ["config", "models", "skills", "mcp", "scheduler", "channels", "vault", "caches", "all"],
        }, null, 2);
      }

      case "config": {
        const result = await _reloadConfig();
        eventBus.emit("system:reload", { component: "config" });
        return `Config reloaded. Default model: ${result.defaultModel}`;
      }

      case "models": {
        const result = _reloadModels();
        eventBus.emit("system:reload", { component: "models" });
        return `Models reloaded. Provider cache cleared. Model: ${result.previous} → ${result.current}`;
      }

      case "skills": {
        const result = await _reloadSkills();
        eventBus.emit("system:reload", { component: "skills" });
        return `Skills reloaded: ${result.skills} loaded. Embeddings re-indexing in background.`;
      }

      case "mcp": {
        const result = await _reloadMCP();
        eventBus.emit("system:reload", { component: "mcp" });
        return `MCP servers reloaded: ${result.mcpServers} reconnected.`;
      }

      case "scheduler": {
        const result = await _reloadScheduler();
        eventBus.emit("system:reload", { component: "scheduler" });
        return `Scheduler reloaded: ${result.jobs} jobs, ${result.running} running.`;
      }

      case "channels": {
        const result = await _reloadChannels();
        eventBus.emit("system:reload", { component: "channels" });
        return `Channels reloaded: ${result.channels} active.`;
      }

      case "vault": {
        const result = _reloadVault();
        eventBus.emit("system:reload", { component: "vault" });
        return `Vault: ${result.vault}${result.secrets ? ` (${result.secrets} secrets injected)` : ""}`;
      }

      case "caches": {
        _clearCaches();
        eventBus.emit("system:reload", { component: "caches" });
        return "Web fetch + search caches cleared.";
      }

      case "all": {
        const results = {};
        results.vault = _reloadVault();
        results.config = await _reloadConfig();
        results.models = _reloadModels();
        results.skills = await _reloadSkills();
        results.mcp = await _reloadMCP();
        results.scheduler = await _reloadScheduler();
        results.channels = await _reloadChannels();
        results.caches = _clearCaches();
        // Reload plugins
        let pluginCount = 0;
        try {
          const { reloadPlugins } = await import("../plugins/PluginLoader.js");
          const { mergePluginTools } = await import("./index.js");
          const reg = await reloadPlugins();
          await mergePluginTools();
          pluginCount = reg.plugins.filter(p => p.status === "loaded").length;
        } catch {}
        eventBus.emit("system:reload", { component: "all" });

        const summary = [
          `Vault: ${results.vault.vault}`,
          `Config: reloaded (model: ${results.models.current})`,
          `Models: provider cache cleared`,
          `Skills: ${results.skills.skills} loaded`,
          `Plugins: ${pluginCount} loaded`,
          `MCP: ${results.mcp.mcpServers} servers reconnected`,
          `Scheduler: ${results.scheduler.jobs} jobs`,
          `Channels: ${results.channels.channels} active`,
          `Caches: cleared`,
        ].join("\n");
        return `Full reload complete:\n${summary}`;
      }

      default:
        return `Unknown action: "${action}". Available: status, config, models, skills, mcp, scheduler, channels, vault, caches, all`;
    }
  } catch (error) {
    return `Reload error: ${error.message}`;
  }
}

export const reloadDescription =
  'reload(action) - Hot-reload system components without restart. ' +
  'Actions: "status" (show loaded state), "config" (reload from DB), "models" (clear provider cache + re-resolve), ' +
  '"skills" (reload skill files), "mcp" (reconnect MCP servers), "scheduler" (reload cron jobs), ' +
  '"channels" (reconnect channels), "vault" (reload secrets), "caches" (clear web caches), ' +
  '"all" (reload everything).';
