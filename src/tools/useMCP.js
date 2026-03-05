import { runMCPAgent } from "../mcp/MCPAgentRunner.js";
import tenantContext from "../tenants/TenantContext.js";

/**
 * useMCP - delegate a task to a specialist agent for a specific MCP server.
 *
 * The specialist agent receives ONLY that server's tools and a focused system prompt.
 * This keeps context lean: main agent stays uncluttered, specialist stays focused.
 *
 * @param {string} serverName       - MCP server name (e.g. "github", "notion", "slack")
 * @param {string} taskDescription  - Full task spec - the agent has no other context
 * @returns {Promise<string>}       - Specialist agent's final response
 */
export async function useMCP(serverName, taskDescription) {
  // Enforce per-tenant MCP server allowlist
  const store = tenantContext.getStore();
  const allowedMcpServers = store?.resolvedConfig?.mcpServers ?? null;
  if (allowedMcpServers !== null && !allowedMcpServers.includes(serverName)) {
    return `Access denied: MCP server "${serverName}" is not in your allowed list. Contact the operator.`;
  }

  const mainSessionId = store?.sessionId || null;
  const parentTaskId = store?.currentTaskId || null;
  return runMCPAgent(serverName, taskDescription, { mainSessionId, parentTaskId });
}

export const useMCPDescription =
  `useMCP(serverName: string, taskDescription: string) - Delegate a task to a specialist MCP agent for the named server.
  - serverName: the MCP server to use (use manageMCP("list") to see available servers)
  - taskDescription: comprehensive task spec - the specialist has no other context, so include all details
  - The specialist gets ONLY that server's tools - lean context, no confusion with built-in tools`;
