/**
 * reload(action) — hot-reload system components without a process restart.
 *
 * Actions (map 1-to-1 with the JS tool):
 *   status   — what's currently loaded
 *   mcp      — disconnect + reconnect every MCP server
 *   scheduler — stop + restart the cron scheduler
 *   channels — stop + start every enabled channel
 *   caches   — clear web search / fetch caches
 *   all      — run every reload action in sequence
 *
 * Keeps the in-process state fresh after config edits — no restart
 * dance, no reconnect prompts.
 */

import { z } from "zod";

import type { ChannelManager } from "../../channels/ChannelManager.js";
import type { CronScheduler } from "../../cron/CronScheduler.js";
import type { MCPManager } from "../../mcp/MCPManager.js";
import type { MCPStore } from "../../mcp/MCPStore.js";
import { clearWebSearchCache } from "./webSearch.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  action: z.enum(["status", "mcp", "scheduler", "channels", "caches", "all"]).default("status"),
});

export interface ReloadDeps {
  readonly mcp: MCPManager;
  readonly mcpStore: MCPStore;
  readonly scheduler: CronScheduler;
  readonly channels: ChannelManager;
}

export function makeReloadTool(deps: ReloadDeps): ToolDef<typeof inputSchema, unknown> {
  return {
    name: "reload",
    description:
      "Hot-reload system components (MCP servers, scheduler, channels, caches). Actions: status, mcp, scheduler, channels, caches, all.",
    category: "agent",
    source: { kind: "core" },
    tags: ["admin", "reload", "hot-swap"],
    inputSchema,
    async execute({ action }, { logger }) {
      switch (action) {
        case "status": {
          const status = {
            mcpServers: deps.mcp.listStatus().length,
            connectedMcp: deps.mcp.listStatus().filter((s) => s.status === "connected").length,
            schedulerRunning: deps.scheduler.isRunning,
            schedulerInflight: deps.scheduler.inflightCount,
            channels: deps.channels.runningSet().size,
            reloadable: ["mcp", "scheduler", "channels", "caches", "all"],
          };
          return status;
        }

        case "mcp": {
          const names = deps.mcp.listStatus().map((s) => s.name);
          let reconnected = 0;
          for (const name of names) {
            try {
              const cfg = deps.mcpStore.get(name);
              if (!cfg || cfg.enabled === false) continue;
              await deps.mcp.disconnect(name);
              await deps.mcp.connect(cfg);
              reconnected++;
            } catch (e) {
              logger.warn("mcp reload failed for server", { name, error: (e as Error).message });
            }
          }
          return { mcpServers: reconnected, message: `Reloaded ${reconnected} MCP server(s)` };
        }

        case "scheduler": {
          deps.scheduler.stop();
          deps.scheduler.start();
          return { running: deps.scheduler.isRunning, message: "Scheduler restarted" };
        }

        case "channels": {
          await deps.channels.stopAll();
          await deps.channels.startAll();
          const n = deps.channels.runningSet().size;
          return { channels: n, message: `Restarted ${n} channel(s)` };
        }

        case "caches": {
          const clearedSearch = clearWebSearchCache();
          return { search: clearedSearch, message: `Cleared web search cache (${clearedSearch} entries)` };
        }

        case "all": {
          const out: Record<string, unknown> = {};

          // MCP
          const names = deps.mcp.listStatus().map((s) => s.name);
          let mcpReconnected = 0;
          for (const name of names) {
            try {
              const cfg = deps.mcpStore.get(name);
              if (!cfg || cfg.enabled === false) continue;
              await deps.mcp.disconnect(name);
              await deps.mcp.connect(cfg);
              mcpReconnected++;
            } catch (e) {
              logger.warn("mcp reload failed for server", { name, error: (e as Error).message });
            }
          }
          out["mcpServers"] = mcpReconnected;

          // Scheduler
          deps.scheduler.stop();
          deps.scheduler.start();
          out["schedulerRunning"] = deps.scheduler.isRunning;

          // Channels
          await deps.channels.stopAll();
          await deps.channels.startAll();
          out["channels"] = deps.channels.runningSet().size;

          // Caches
          out["searchCache"] = clearWebSearchCache();

          return { ...out, message: "Full reload complete" };
        }
      }
    },
  };
}
