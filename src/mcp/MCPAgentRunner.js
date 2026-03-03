import { spawnSubAgent } from "../agents/SubAgentManager.js";
import mcpManager from "./MCPManager.js";

/**
 * MCP Agent Runner - spawns specialist sub-agents for individual MCP servers.
 *
 * Each specialist gets:
 *   - ONLY the tools from its assigned MCP server (no built-in tools)
 *   - A minimal system prompt focused solely on its server's capabilities
 *   - No SOUL.md, no memory, no unrelated tool docs
 *
 * This keeps context lean: a GitHub specialist sees only GitHub tools.
 * A Notion specialist sees only Notion tools. No confusion, no wasted tokens.
 */

/**
 * Build a focused system prompt for an MCP specialist agent.
 * @param {string} serverName - The MCP server name
 * @param {string} toolDocs   - Formatted tool documentation for this server's tools
 * @returns {{ role: "system", content: string }}
 */
function buildMCPAgentSystemPrompt(serverName, toolDocs) {
  return {
    role: "system",
    content: `You are a specialist agent for the "${serverName}" MCP server. You have been delegated a specific task by the main agent. Complete it fully and autonomously using the tools below.

# Response Format

Respond with a JSON object on every turn:
\`\`\`
{
  "type": "tool_call" | "text",
  "tool_call": { "tool_name": "string", "params": ["string", ...] } | null,
  "text_content": "string" | null,
  "finalResponse": boolean
}
\`\`\`

- type "tool_call": set tool_call, set text_content to null, finalResponse to false
- type "text": set text_content with a clear summary of what you did, set tool_call to null, finalResponse to true

# Available Tools

${toolDocs}

# How to Call MCP Tools

All MCP tool params must be passed as a single JSON string (the first and only argument):
  tool_name: "mcp__${serverName}__someToolName"
  params: ['{"param1":"value1","param2":"value2"}']

# Rules - You Own This Task

- **Do the work, don't describe it.** Your first response must be a tool_call, not a plan.
- **Chain calls until fully done.** After each tool result, decide: need more tools? Call another. Only set finalResponse true when the task is genuinely complete.
- **Never ask for clarification.** You have everything you need in the task description. Make reasonable decisions and proceed.
- **Handle errors yourself.** If a tool call fails, read the error, adjust your approach, try again. Do not give up and report failure unless you have exhausted all approaches.
- **Be thorough.** If the task says "update all tasks in a project", update all of them. If it says "research X", gather enough detail to be useful. Don't do a half job.
- **End with a useful summary.** When done, set finalResponse true and write a clear summary: what was done, what was created/updated/found, and any important details the main agent needs.`,
  };
}

/**
 * Run a specialist MCP agent for the given server.
 *
 * @param {string} serverName       - MCP server name (e.g. "github", "notion")
 * @param {string} taskDescription  - Full task description (no other context available)
 * @param {object} options          - Forwarded to spawnSubAgent (parentTaskId, channelMeta, approvalMode, timeout, model)
 * @returns {Promise<string>}       - Agent's final response
 */
export async function runMCPAgent(serverName, taskDescription, options = {}) {
  // Get only this server's tool functions
  const serverTools = mcpManager.getServerTools(serverName);

  if (Object.keys(serverTools).length === 0) {
    const available = mcpManager.list().map((s) => s.name);
    if (available.length === 0) {
      return `No MCP servers are connected. Check config/mcp.json to enable servers.`;
    }
    return `MCP server "${serverName}" not found or has no tools. Available servers: ${available.join(", ")}`;
  }

  // Build tool docs for this server's system prompt
  const toolDocs = Object.keys(serverTools)
    .map((fullName) => {
      const entry = mcpManager.toolMap.get(fullName);
      if (!entry) return `### ${fullName}(argsJson: string)`;
      const schema = entry.inputSchema?.properties || {};
      const required = entry.inputSchema?.required || [];
      const params = Object.entries(schema)
        .map(([k, v]) => `${k}${required.includes(k) ? "" : "?"}: ${v.type || "any"}`)
        .join(", ");
      const desc = entry.description || entry.toolName;
      const paramLine = params ? `\n- argsJson: \`{${params}}\`` : "";
      return `### ${fullName}(argsJson: string)\n${desc}${paramLine}`;
    })
    .join("\n\n");

  const systemPromptOverride = buildMCPAgentSystemPrompt(serverName, toolDocs);

  console.log(
    `[MCPAgentRunner] Spawning specialist for "${serverName}" (${Object.keys(serverTools).length} tools)`
  );

  return spawnSubAgent(taskDescription, {
    ...options,
    toolOverride: serverTools,
    systemPromptOverride,
    // MCP agents are always depth 1 - they don't spawn further sub-agents
    depth: 1,
  });
}
