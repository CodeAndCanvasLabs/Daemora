import { spawnSubAgent } from "../agents/SubAgentManager.js";
import mcpManager from "./MCPManager.js";
import { MCPClient } from "./MCPClient.js";
import { toolFunctions } from "../tools/index.js";
import { createSession, getSession, setMessages } from "../services/sessions.js";
import { compactForSession } from "../utils/msgText.js";
import tenantContext from "../tenants/TenantContext.js";

/**
 * Base tools injected into every MCP specialist agent alongside their server tools.
 * Without these, the agent can't research, read files, or write results.
 */
const MCP_BASE_TOOLS = [
  "readFile", "writeFile", "editFile", "listDirectory",
  "executeCommand",
  "webFetch", "webSearch",
  "createDocument",
  "replyToUser",
];

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

## MCP Tools (${serverName})

${toolDocs}

## Base Tools
You also have standard tools for research, file operations, and output:
- readFile(filePath, offset?, limit?) — Read file contents
- writeFile(filePath, content) — Create or overwrite file
- editFile(filePath, oldString, newString) — Find-and-replace in file
- listDirectory(dirPath) — List files and folders
- glob(pattern, directory?) — Find files by glob pattern
- grep(pattern, optionsJson?) — Content search
- executeCommand(command, optionsJson?) — Run shell command
- webFetch(url, optionsJson?) — Fetch URL content as text
- webSearch(query, optionsJson?) — Search the web
- createDocument(filePath, content, format?) — Create markdown, pdf, or docx
- replyToUser(message) — Send progress update to user mid-task

# How to Call MCP Tools

All MCP tool params must be passed as a single JSON string (the first and only argument):
  tool_name: "mcp__${serverName}__someToolName"
  params: ['{"param1":"value1","param2":"value2"}']

Base tools use regular string params (array of strings), not JSON.

# Rules - You Own This Task

- **Do the work, don't describe it.** Your first response must be a tool_call, not a plan.
- **Chain calls until fully done.** After each tool result, decide: need more tools? Call another. Only set finalResponse true when the task is genuinely complete. Never set finalResponse true with "in progress" or "will follow up" — that is a failure.
- **Never ask for clarification.** You have everything you need in the task description. Make reasonable decisions and proceed.
- **Handle errors yourself.** If a tool call fails, read the error, adjust your approach, try again. Do not give up and report failure unless you have exhausted all approaches.
- **Mid-task user follow-up** → replyToUser() to acknowledge immediately, fold in, keep working.
- **Be thorough.** If the task says "update all tasks in a project", update all of them. If it says "research X", gather enough detail to be useful. Don't do a half job.
- **Use base tools for research.** webSearch and webFetch for gathering data, readFile/writeFile for reading and saving, createDocument for reports. MCP tools are for the ${serverName} service specifically.
- **End with a concise summary.** When done, set finalResponse true. Write 1-3 sentences: what was done and key outcomes. Never dump raw API responses, full JSON payloads, message IDs, status codes, or technical artifacts. The main agent will relay your response to the user.`,
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
  const { mainSessionId, ...restOptions } = options;

  // Get only this server's tool functions.
  // First check global connected servers; if not found, try tenant's private server config.
  let serverTools = mcpManager.getServerTools(serverName);
  let tempClient = null;
  let tempToolMeta = {}; // fullName → { description, inputSchema } for tenant-owned server tools

  if (Object.keys(serverTools).length === 0) {
    // Try tenant's own private MCP server definitions
    const store = tenantContext.getStore();
    const ownMcpServers = store?.resolvedConfig?.ownMcpServers ?? {};
    const ownServerConfig = ownMcpServers[serverName];

    if (ownServerConfig) {
      try {
        console.log(`[MCPAgentRunner] Connecting tenant-owned MCP server "${serverName}"`);
        tempClient = new MCPClient(serverName, ownServerConfig);
        const tools = await tempClient.connect();
        // Build serverTools map with same arg-parsing signature as MCPManager.getServerTools()
        serverTools = {};
        for (const tool of tools) {
          const fullName = `mcp__${serverName}__${tool.name}`;
          tempToolMeta[fullName] = { description: tool.description, inputSchema: tool.inputSchema };
          const schema = tool.inputSchema;
          const toolName = tool.name;
          const client = tempClient;
          serverTools[fullName] = async (...args) => {
            let toolArgs = {};
            if (args[0]) {
              try {
                toolArgs = typeof args[0] === "string" ? JSON.parse(args[0]) : args[0];
              } catch {
                const props = schema?.properties || {};
                const keys = Object.keys(props);
                for (let i = 0; i < keys.length && i < args.length; i++) {
                  toolArgs[keys[i]] = args[i];
                }
              }
            }
            console.log(`      [MCP:${fullName}] Calling with: ${JSON.stringify(toolArgs).slice(0, 200)}`);
            try {
              return await client.callTool(toolName, toolArgs);
            } catch (err) {
              return `MCP tool error: ${err.message}`;
            }
          };
        }
      } catch (err) {
        return `Failed to connect tenant MCP server "${serverName}": ${err.message}`;
      }
    }
  }

  if (Object.keys(serverTools).length === 0) {
    const available = mcpManager.list().map((s) => s.name);
    if (available.length === 0) {
      return `No MCP servers are connected. Check config/mcp.json to enable servers.`;
    }
    return `MCP server "${serverName}" not found or has no tools. Available servers: ${available.join(", ")}`;
  }

  // Build tool docs for this server's system prompt (include nested schemas).
  // For global servers, look up mcpManager.toolMap; for tenant-owned, use tempToolMeta.
  const toolDocs = Object.keys(serverTools)
    .map((fullName) => {
      const entry = mcpManager.toolMap.get(fullName) || tempToolMeta[fullName];
      if (!entry) return `### ${fullName}(argsJson: string)`;
      const desc = entry.description || entry.toolName;
      const schema = entry.inputSchema;
      // Show full JSON schema so the sub-agent knows exact field names
      let schemaDoc = "";
      if (schema) {
        try {
          schemaDoc = "\n- Schema:\n```json\n" + JSON.stringify(schema, null, 2) + "\n```";
        } catch {
          const props = schema.properties || {};
          const required = schema.required || [];
          const params = Object.entries(props)
            .map(([k, v]) => `${k}${required.includes(k) ? "" : "?"}: ${v.type || "any"}`)
            .join(", ");
          schemaDoc = params ? `\n- argsJson: \`{${params}}\`` : "";
        }
      }
      return `### ${fullName}(argsJson: string)\n${desc}${schemaDoc}`;
    })
    .join("\n\n");

  const systemPromptOverride = buildMCPAgentSystemPrompt(serverName, toolDocs);

  // Load sub-agent session history (persistent across calls)
  const subSessionId = mainSessionId ? `${mainSessionId}--${serverName}` : null;
  let historyMessages = [];
  if (subSessionId) {
    const subSession = getSession(subSessionId);
    if (subSession && subSession.messages.length > 0) {
      historyMessages = subSession.messages.map(m => ({ role: m.role, content: m.content }));
      console.log(`[MCPAgentRunner] Loaded ${historyMessages.length} history messages for "${serverName}"`);
    }
  }

  console.log(
    `[MCPAgentRunner] Spawning specialist for "${serverName}" (${Object.keys(serverTools).length} tools)`
  );

  // Merge base tools with MCP server tools so the agent can research, read files, etc.
  const baseTools = {};
  for (const name of MCP_BASE_TOOLS) {
    if (toolFunctions[name]) baseTools[name] = toolFunctions[name];
  }
  const mergedTools = { ...baseTools, ...serverTools };

  const fullResult = await spawnSubAgent(taskDescription, {
    ...restOptions,
    toolOverride: mergedTools,
    systemPromptOverride,
    depth: 1,
    historyMessages,
    returnFullResult: true,
  });

  // Save sub-agent session (cap at 100 messages)
  if (subSessionId && fullResult.messages) {
    let subSession = getSession(subSessionId);
    if (!subSession) subSession = createSession(subSessionId);
    const capped = fullResult.messages.length > 100
      ? fullResult.messages.slice(-100)
      : fullResult.messages;
    setMessages(subSessionId, compactForSession(capped));
    console.log(`[MCPAgentRunner] Saved ${capped.length} messages to sub-session "${subSessionId}"`);
  }

  // Disconnect temp client for tenant-owned server (not registered in global MCPManager)
  if (tempClient) {
    try { await tempClient.disconnect(); } catch {}
  }

  return typeof fullResult === "string" ? fullResult : fullResult.text;
}
