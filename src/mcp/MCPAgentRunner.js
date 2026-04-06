import { createMCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawnSubAgent } from "../agents/SubAgentManager.js";
import mcpManager from "./MCPManager.js";
import { toolFunctions } from "../tools/index.js";
import { createSession, getSession, setMessages } from "../services/sessions.js";
import { compactForSession } from "../utils/msgText.js";
import requestContext from "../core/RequestContext.js";

/**
 * Base tools injected into every MCP specialist agent alongside their server tools.
 * Without these, the agent can't research, read files, or write results.
 */
const MCP_BASE_TOOLS = [
  "readFile", "writeFile", "editFile", "listDirectory",
  "glob", "grep",
  "executeCommand",
  "webFetch", "webSearch",
  "createDocument",
  "replyToUser",
];

/**
 * MCP Agent Runner - spawns specialist sub-agents for individual MCP servers.
 *
 * Uses @ai-sdk/mcp to create proper AI SDK tools from MCP servers.
 * Each specialist gets:
 *   - MCP tools with proper Zod schemas (via @ai-sdk/mcp)
 *   - Base tools for file I/O, web, etc.
 *   - A focused system prompt - no manual tool docs needed
 */

// ── Env var expansion (reused from MCPClient) ─────────────────────────────────

const SENSITIVE_ENV_PATTERN = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL|_AUTH|_SID|_PRIVATE|_PASSPHRASE|VAULT_)$/i;

function expandEnvVars(value) {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? "");
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = expandEnvVars(v);
    }
    return out;
  }
  return value;
}

function _buildMcpEnv(declaredEnv) {
  const safe = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!SENSITIVE_ENV_PATTERN.test(k)) safe[k] = v;
  }
  if (declaredEnv) Object.assign(safe, declaredEnv);
  return safe;
}

// ── Transport builder ─────────────────────────────────────────────────────────

/**
 * Build an MCP transport from server config.
 * Maps our config format to @modelcontextprotocol/sdk transports.
 */
function _buildTransport(serverConfig) {
  const cfg = serverConfig;

  // stdio - local subprocess
  if (cfg.command) {
    return new StdioClientTransport({
      command: cfg.command,
      args: cfg.args || [],
      env: _buildMcpEnv(expandEnvVars(cfg.env || {})),
    });
  }

  if (!cfg.url) {
    throw new Error(`Invalid MCP config: need 'command' (stdio) or 'url' (http/sse)`);
  }

  const url = new URL(expandEnvVars(cfg.url));
  const headers = expandEnvVars(cfg.headers || {});
  const hasHeaders = Object.keys(headers).length > 0;

  // SSE
  if (cfg.transport === "sse") {
    return new SSEClientTransport(url, {
      requestInit: hasHeaders ? { headers } : undefined,
      eventSourceInit: hasHeaders ? { headers } : undefined,
    });
  }

  // Streamable HTTP (default)
  return new StreamableHTTPClientTransport(url, {
    requestInit: hasHeaders ? { headers } : undefined,
  });
}

// ── System prompt ─────────────────────────────────────────────────────────────

/**
 * Build a focused system prompt for an MCP specialist agent.
 * No tool docs needed - tools are self-describing via Zod schemas from @ai-sdk/mcp.
 */
function buildMCPAgentSystemPrompt(serverName) {
  return {
    role: "system",
    content: `You are a specialist agent for the "${serverName}" MCP server. You have been delegated a specific task by the main agent. Complete it fully and autonomously using the tools available to you.

# Rules - You Own This Task

- **Do the work, don't describe it.** Your first response must be a tool_call, not a plan.
- **Chain calls until fully done.** After each tool result, decide: need more tools? Call another. Only set finalResponse true when the task is genuinely complete. Never set finalResponse true with "in progress" or "will follow up" - that is a failure.
- **Never ask for clarification.** You have everything you need in the task description. Make reasonable decisions and proceed.
- **Handle errors yourself.** If a tool call fails, read the error, adjust your approach, try again. Do not give up and report failure unless you have exhausted all approaches.
- **Mid-task user follow-up** → replyToUser() to acknowledge immediately, fold in, keep working.
- **Be thorough.** If the task says "update all tasks in a project", update all of them. If it says "research X", gather enough detail to be useful. Don't do a half job.
- **Use base tools for research.** webSearch and webFetch for gathering data, readFile/writeFile for reading and saving, createDocument for reports. MCP tools are for the ${serverName} service specifically.
- **End with a concise summary.** When done, set finalResponse true. Write 1-3 sentences: what was done and key outcomes. Never dump raw API responses, full JSON payloads, message IDs, status codes, or technical artifacts. The main agent will relay your response to the user.`,
  };
}

// ── Server config resolution ──────────────────────────────────────────────────

/**
 * Resolve server config from global MCPManager.
 * @returns {{ config: object, source: "global" } | null}
 */
function _getServerConfig(serverName) {
  const mcpConfig = mcpManager.readConfig();
  if (mcpConfig.mcpServers?.[serverName]) {
    return { config: mcpConfig.mcpServers[serverName], source: "global" };
  }
  return null;
}

// ── Main runner ───────────────────────────────────────────────────────────────

/**
 * Run a specialist MCP agent for the given server.
 *
 * Uses @ai-sdk/mcp to create proper AI SDK tools with Zod schemas.
 * The sub-agent gets native tool calling - no string-based JSON parsing.
 *
 * @param {string} serverName       - MCP server name (e.g. "github", "notion")
 * @param {string} taskDescription  - Full task description
 * @param {object} options          - Forwarded to spawnSubAgent
 * @returns {Promise<string>}       - Agent's final response
 */
export async function runMCPAgent(serverName, taskDescription, options = {}) {
  const { mainSessionId, ...restOptions } = options;

  // Resolve server config
  const resolved = _getServerConfig(serverName);
  if (!resolved) {
    const available = mcpManager.list().map((s) => s.name);
    if (available.length === 0) {
      return `No MCP servers are connected. Check config/mcp.json to enable servers.`;
    }
    return `MCP server "${serverName}" not found or has no tools. Available servers: ${available.join(", ")}`;
  }

  // Create @ai-sdk/mcp client with proper transport
  let mcpClient;
  try {
    console.log(`[MCPAgentRunner] Creating @ai-sdk/mcp client for "${serverName}" (${resolved.source})`);
    const transport = _buildTransport(resolved.config);
    mcpClient = await createMCPClient({ transport });
  } catch (err) {
    return `Failed to connect MCP server "${serverName}": ${err.message}`;
  }

  try {
    // Get proper AI SDK tools with Zod schemas - automatic schema discovery
    const mcpTools = await mcpClient.tools();
    const mcpToolCount = Object.keys(mcpTools).length;

    if (mcpToolCount === 0) {
      return `MCP server "${serverName}" connected but has no tools.`;
    }

    // Rename MCP tools to namespaced format: toolName → mcp__serverName__toolName
    const namespacedMcpTools = {};
    for (const [name, toolDef] of Object.entries(mcpTools)) {
      namespacedMcpTools[`mcp__${serverName}__${name}`] = toolDef;
    }

    // Build system prompt (simplified - tools are self-describing via schemas)
    const systemPromptOverride = buildMCPAgentSystemPrompt(serverName);

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
      `[MCPAgentRunner] Spawning specialist for "${serverName}" (${mcpToolCount} MCP tools + ${MCP_BASE_TOOLS.length} base tools)`
    );

    // Spawn sub-agent:
    //   - tools: base tools (resolved from toolFunctions via name list)
    //   - aiToolOverrides: MCP tools (pre-built AI SDK tools from @ai-sdk/mcp)
    const fullResult = await spawnSubAgent(taskDescription, {
      ...restOptions,
      tools: MCP_BASE_TOOLS,
      aiToolOverrides: namespacedMcpTools,
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

    return typeof fullResult === "string" ? fullResult : fullResult.text;
  } finally {
    // Always close the MCP client (disconnects transport)
    try { await mcpClient.close(); } catch {}
  }
}
