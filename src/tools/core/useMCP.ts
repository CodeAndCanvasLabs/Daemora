/**
 * use_mcp — call a specific tool on a connected MCP server.
 *
 * `tool` is required. The system prompt lists every connected server's
 * tool names (`server: N tools (tool_a, tool_b, …)`) so the model has
 * the catalog up-front — there's no reason for a two-round-trip
 * "discover then invoke" dance. If the agent doesn't know which tool
 * to use, it should re-read the system prompt; the previous version's
 * auto-discovery return was burning one LLM step per delegation.
 *
 * The `task` field is kept for audit logging (shows up in the task
 * record's toolCalls.args) — it's not passed to the MCP server itself;
 * the server receives `args` only.
 */

import { z } from "zod";

import type { MCPManager } from "../../mcp/MCPManager.js";
import { NotFoundError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  server: z.string().min(1).describe("Connected MCP server name. See `## Connected MCP Servers` in the system prompt."),
  tool: z.string().min(1).describe("Exact tool name on that server. The system prompt lists each server's tools."),
  args: z.record(z.unknown()).optional().describe("Arguments for the tool. Shape is defined by the tool's inputSchema."),
  task: z.string().optional().describe("Optional human-readable description of intent — recorded for audit only, not passed to the server."),
});

export function makeUseMCPTool(mcp: MCPManager): ToolDef<typeof inputSchema, { server: string; tool: string; result: unknown }> {
  return {
    name: "use_mcp",
    description:
      "Call a tool on a connected MCP server. `server` + `tool` are required — the system prompt lists every connected server with its tool names.",
    category: "agent",
    source: { kind: "core" },
    alwaysOn: true,
    tags: ["mcp", "integration"],
    inputSchema,
    async execute({ server, tool, args }) {
      const status = mcp.listStatus();
      const connectedNames = status.filter((s) => s.status === "connected").map((s) => s.name);
      const serverInfo = status.find((s) => s.name === server);

      if (!serverInfo) {
        // Only reveal *connected* servers in the error. Leaking every
        // disabled default makes the agent claim they're available.
        const hint = connectedNames.length > 0
          ? `Connected servers: ${connectedNames.join(", ")}.`
          : "No MCP servers are currently connected.";
        throw new NotFoundError(
          `MCP server "${server}" not found or not connected. ${hint} ` +
          `Additional integrations can be enabled by the user at /mcp.`,
        );
      }

      if (serverInfo.status !== "connected") {
        const reason = serverInfo.configured
          ? "disabled — user must enable it at /mcp"
          : "not configured — user must add required credentials at /mcp";
        throw new Error(
          `MCP server "${server}" is ${reason}. ` +
          (connectedNames.length > 0 ? `Connected alternatives: ${connectedNames.join(", ")}.` : ""),
        );
      }

      // Validate tool belongs to this server so we fail fast with a
      // useful message instead of letting the MCP server return an
      // obscure "unknown method" error.
      const knownTools = new Set(serverInfo.tools.map((t) => t.name));
      if (!knownTools.has(tool)) {
        throw new ValidationError(
          `Tool "${tool}" not found on MCP server "${server}". Available on this server: ${serverInfo.tools.map((t) => t.name).join(", ")}.`,
        );
      }

      const result = await mcp.callTool(server, tool, args ?? {});
      return { server, tool, result };
    },
  };
}
