/**
 * manage_mcp(action, ...) — configure MCP servers from inside the agent.
 *
 * Actions:
 *   list       — all configured servers with status + tool counts
 *   get        — detail for a single server
 *   add        — register a new server (stdio via command+args OR http via url)
 *   update     — patch server config
 *   remove     — delete a server (disconnects first)
 *   enable     — flip enabled flag on, reconnects if possible
 *   disable    — flip enabled flag off, disconnects
 *   reconnect  — force disconnect + reconnect for one server
 *   tools      — list tools exposed by a connected server
 */

import { z } from "zod";

import type { MCPManager } from "../../mcp/MCPManager.js";
import type { MCPStore } from "../../mcp/MCPStore.js";
import { NotFoundError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  action: z.enum([
    "list", "get", "add", "update", "remove",
    "enable", "disable", "reconnect", "tools",
  ]),
  name: z.string().optional().describe("Server name — unique id used in tool naming (mcp__<name>__<tool>)."),
  command: z.string().optional().describe("Stdio-transport command to spawn."),
  args: z.array(z.string()).optional().describe("Args passed to the spawn command."),
  url: z.string().optional().describe("HTTP/SSE endpoint for http-transport servers."),
  env: z.record(z.string(), z.string()).optional().describe("Environment variables passed to the spawned process."),
  headers: z.record(z.string(), z.string()).optional().describe("Extra HTTP headers for http-transport."),
  transport: z.enum(["stdio", "http", "sse"]).optional(),
  enabled: z.boolean().optional(),
});

export function makeManageMCPTool(store: MCPStore, manager: MCPManager): ToolDef<typeof inputSchema, unknown> {
  return {
    name: "manage_mcp",
    description:
      "Register and manage Model Context Protocol servers. Actions: list, get, add, update, remove, enable, disable, reconnect, tools.",
    category: "agent",
    source: { kind: "core" },
    tags: ["mcp", "integration", "tool-registry"],
    inputSchema,
    async execute(input, { logger }) {
      switch (input.action) {
        case "list": {
          return manager.listStatus();
        }

        case "get": {
          if (!input.name) throw new ValidationError("name is required");
          const cfg = store.get(input.name);
          if (!cfg) throw new NotFoundError(`MCP server not found: ${input.name}`);
          const status = manager.listStatus().find((s) => s.name === input.name);
          return { config: cfg, status };
        }

        case "add": {
          if (!input.name) throw new ValidationError("name is required");
          if (!input.command && !input.url) {
            throw new ValidationError("either `command` (stdio) or `url` (http) is required");
          }
          const existing = store.get(input.name);
          if (existing) throw new ValidationError(`MCP server already exists: ${input.name}`);
          const entry = store.add(input.name, {
            ...(input.command ? { command: input.command } : {}),
            ...(input.args ? { args: input.args } : {}),
            ...(input.url ? { url: input.url } : {}),
            ...(input.env ? { env: input.env } : {}),
            ...(input.headers ? { headers: input.headers } : {}),
            ...(input.transport ? { transport: input.transport } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          });
          if (entry.enabled !== false) {
            await manager.connect(entry).catch((err) => {
              logger.warn("mcp connect failed", { name: input.name, error: (err as Error).message });
            });
          }
          return { name: entry.name, message: `MCP server '${entry.name}' added` };
        }

        case "update": {
          if (!input.name) throw new ValidationError("name is required");
          const updates: Parameters<MCPStore["update"]>[1] = {};
          if (input.command !== undefined) updates.command = input.command;
          if (input.args !== undefined) updates.args = input.args;
          if (input.url !== undefined) updates.url = input.url;
          if (input.env !== undefined) updates.env = input.env;
          if (input.headers !== undefined) updates.headers = input.headers;
          if (input.transport !== undefined) updates.transport = input.transport;
          if (input.enabled !== undefined) updates.enabled = input.enabled;
          const entry = store.update(input.name, updates);
          if (!entry) throw new NotFoundError(`MCP server not found: ${input.name}`);
          // Reconnect to pick up the new config.
          await manager.disconnect(input.name);
          if (entry.enabled !== false) {
            await manager.connect(entry).catch((err) => {
              logger.warn("mcp reconnect failed", { name: input.name, error: (err as Error).message });
            });
          }
          return { name: input.name, message: `MCP server '${input.name}' updated` };
        }

        case "remove": {
          if (!input.name) throw new ValidationError("name is required");
          await manager.disconnect(input.name);
          const ok = store.remove(input.name);
          if (!ok) throw new NotFoundError(`MCP server not found: ${input.name}`);
          return { name: input.name, removed: true, message: `MCP server '${input.name}' removed` };
        }

        case "enable":
        case "disable": {
          if (!input.name) throw new ValidationError("name is required");
          const ok = store.setEnabled(input.name, input.action === "enable");
          if (!ok) throw new NotFoundError(`MCP server not found: ${input.name}`);
          if (input.action === "enable") {
            const entry = store.get(input.name);
            if (entry) {
              await manager.connect(entry).catch((err) => {
                logger.warn("mcp connect failed", { name: input.name, error: (err as Error).message });
              });
            }
          } else {
            await manager.disconnect(input.name);
          }
          return { name: input.name, enabled: input.action === "enable", message: `MCP server '${input.name}' ${input.action}d` };
        }

        case "reconnect": {
          if (!input.name) throw new ValidationError("name is required");
          const entry = store.get(input.name);
          if (!entry) throw new NotFoundError(`MCP server not found: ${input.name}`);
          await manager.disconnect(input.name);
          await manager.connect(entry);
          const status = manager.listStatus().find((s) => s.name === input.name);
          return { name: input.name, status, message: `MCP server '${input.name}' reconnected` };
        }

        case "tools": {
          if (!input.name) throw new ValidationError("name is required");
          const status = manager.listStatus().find((s) => s.name === input.name);
          if (!status) throw new NotFoundError(`MCP server not found: ${input.name}`);
          return { name: input.name, count: status.tools.length, tools: status.tools };
        }
      }
    },
  };
}
