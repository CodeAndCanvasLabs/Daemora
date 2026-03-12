/**
 * reload(action) - Hot-reload system components without restart.
 *
 * Actions:
 *   all       - reload everything (config, skills, mcp, scheduler, channels)
 *   config    - reload config from SQLite + vault
 *   skills    - reload skill files + re-embed
 *   mcp       - reload all MCP server connections
 *   scheduler - reload cron jobs from DB (stop + restart timers)
 *   channels  - reconnect all active channels
 *   status    - show what's currently loaded and reloadable
 */
import { config, reloadFromDb } from "../config/default.js";
import { resolveDefaultModel } from "../models/ModelRouter.js";
import skillLoader from "../skills/SkillLoader.js";
import mcpManager from "../mcp/MCPManager.js";
import scheduler from "../scheduler/Scheduler.js";
import channelRegistry from "../channels/index.js";
import eventBus from "../core/EventBus.js";

async function _reloadConfig() {
  await reloadFromDb();
  // Re-resolve default model if not explicitly set
  if (!process.env.DEFAULT_MODEL) {
    config.defaultModel = resolveDefaultModel();
  }
  return { config: "reloaded", defaultModel: config.defaultModel };
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
  // Stop and restart all active channels
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
          skills: skills.length,
          mcpServers: mcpServers.length,
          scheduler: {
            totalJobs: schedulerStatus.totalJobs,
            runningJobs: schedulerStatus.runningJobs,
            started: schedulerStatus.started,
          },
          reloadable: ["config", "skills", "mcp", "scheduler", "channels", "all"],
        }, null, 2);
      }

      case "config": {
        const result = await _reloadConfig();
        eventBus.emit("system:reload", { component: "config" });
        return `Config reloaded. Default model: ${result.defaultModel}`;
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

      case "all": {
        const results = {};
        results.config = await _reloadConfig();
        results.skills = await _reloadSkills();
        results.mcp = await _reloadMCP();
        results.scheduler = await _reloadScheduler();
        // Channels last — depends on config being fresh
        results.channels = await _reloadChannels();
        eventBus.emit("system:reload", { component: "all" });

        const summary = [
          `Config: reloaded (model: ${results.config.defaultModel})`,
          `Skills: ${results.skills.skills} loaded`,
          `MCP: ${results.mcp.mcpServers} servers reconnected`,
          `Scheduler: ${results.scheduler.jobs} jobs`,
          `Channels: ${results.channels.channels} active`,
        ].join("\n");
        return `Full reload complete:\n${summary}`;
      }

      default:
        return `Unknown action: "${action}". Available: status, config, skills, mcp, scheduler, channels, all`;
    }
  } catch (error) {
    return `Reload error: ${error.message}`;
  }
}

export const reloadDescription =
  'reload(action) - Hot-reload system components without restart. ' +
  'Actions: "status" (show loaded state), "config" (reload from DB), "skills" (reload skill files), ' +
  '"mcp" (reconnect MCP servers), "scheduler" (reload cron jobs), "channels" (reconnect channels), ' +
  '"all" (reload everything).';
