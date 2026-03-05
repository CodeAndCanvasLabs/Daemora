import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { config } from "../config/default.js";
import { MCPClient } from "./MCPClient.js";

/**
 * MCP Manager - manages multiple MCP server connections.
 *
 * Reads config from config/mcp.json (same format as Claude Code's .mcp.json).
 * Each server's tools are exposed as `mcp__{serverName}__{toolName}` in the agent.
 *
 * Config format:
 * ```json
 * {
 *   "mcpServers": {
 *     "github": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-github"],
 *       "env": { "GITHUB_TOKEN": "..." }
 *     },
 *     "memory": {
 *       "url": "http://localhost:3100/mcp",
 *       "transport": "sse"
 *     }
 *   }
 * }
 * ```
 */
class MCPManager {
  constructor() {
    this.clients = new Map();
    this.toolMap = new Map(); // mcp__server__tool -> { client, toolName }
    this.mcpConfigPath = join(config.rootDir, "config", "mcp.json");
  }

  /**
   * Read and parse the current mcp.json config.
   */
  readConfig() {
    if (!existsSync(this.mcpConfigPath)) return { mcpServers: {} };
    try {
      return JSON.parse(readFileSync(this.mcpConfigPath, "utf-8"));
    } catch {
      return { mcpServers: {} };
    }
  }

  /**
   * Write the config back to mcp.json.
   */
  writeConfig(mcpConfig) {
    writeFileSync(this.mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
  }

  /**
   * Connect a single server and register its tools.
   */
  async connectServer(name, serverConfig) {
    // Disconnect existing if present
    if (this.clients.has(name)) {
      await this.disconnectServer(name);
    }

    const client = new MCPClient(name, serverConfig);
    this.clients.set(name, client);

    const tools = await client.connect();

    for (const tool of tools) {
      const fullName = `mcp__${name}__${tool.name}`;
      this.toolMap.set(fullName, {
        client,
        toolName: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }

    return tools;
  }

  /**
   * Disconnect a server and remove its tools.
   */
  async disconnectServer(name) {
    const client = this.clients.get(name);
    if (!client) return;

    await client.disconnect();
    this.clients.delete(name);

    // Remove all tools from this server
    const prefix = `mcp__${name}__`;
    for (const key of this.toolMap.keys()) {
      if (key.startsWith(prefix)) this.toolMap.delete(key);
    }
  }

  /**
   * Dynamically add a new MCP server - saves to config and connects.
   * @param {string} name - Server name (e.g. "github")
   * @param {object} serverConfig - Config object (command+args or url+transport)
   * @returns {string} Result message
   */
  async addServer(name, serverConfig) {
    if (!name || typeof name !== "string") throw new Error("name is required");
    if (!serverConfig || typeof serverConfig !== "object") throw new Error("serverConfig is required");
    if (!serverConfig.command && !serverConfig.url) throw new Error("serverConfig must have 'command' (stdio) or 'url' (SSE/HTTP)");

    // Write to config
    const mcpConfig = this.readConfig();
    mcpConfig.mcpServers = mcpConfig.mcpServers || {};
    mcpConfig.mcpServers[name] = { ...serverConfig, enabled: true };
    this.writeConfig(mcpConfig);

    // Connect immediately
    const tools = await this.connectServer(name, serverConfig);
    return `Server "${name}" added and connected - ${tools.length} tools: ${tools.map(t => t.name).join(", ") || "(none)"}`;
  }

  /**
   * Dynamically remove an MCP server - disconnects and removes from config.
   * @param {string} name - Server name
   * @returns {string} Result message
   */
  async removeServer(name) {
    await this.disconnectServer(name);

    const mcpConfig = this.readConfig();
    if (mcpConfig.mcpServers && mcpConfig.mcpServers[name]) {
      delete mcpConfig.mcpServers[name];
      this.writeConfig(mcpConfig);
    }

    return `Server "${name}" removed.`;
  }

  /**
   * Enable or disable a server in config (does not reconnect - use reload).
   */
  async setEnabled(name, enabled) {
    const mcpConfig = this.readConfig();
    if (!mcpConfig.mcpServers?.[name]) {
      throw new Error(`Server "${name}" not found in config`);
    }
    mcpConfig.mcpServers[name].enabled = enabled;
    this.writeConfig(mcpConfig);

    if (enabled) {
      const tools = await this.connectServer(name, mcpConfig.mcpServers[name]);
      return `Server "${name}" enabled and connected - ${tools.length} tools.`;
    } else {
      await this.disconnectServer(name);
      return `Server "${name}" disabled and disconnected.`;
    }
  }

  /**
   * Reload a server - disconnect, re-read config, reconnect.
   */
  async reloadServer(name) {
    const mcpConfig = this.readConfig();
    const serverConfig = mcpConfig.mcpServers?.[name];
    if (!serverConfig) throw new Error(`Server "${name}" not found in config`);
    if (serverConfig.enabled === false) {
      await this.disconnectServer(name);
      return `Server "${name}" is disabled - not reconnected.`;
    }

    const tools = await this.connectServer(name, serverConfig);
    return `Server "${name}" reloaded - ${tools.length} tools.`;
  }

  /**
   * Initialize and connect to all configured MCP servers.
   */
  async init() {
    const mcpConfigPath = this.mcpConfigPath;

    if (!existsSync(mcpConfigPath)) {
      console.log(`[MCPManager] No config/mcp.json - MCP disabled`);
      return;
    }

    let mcpConfig;
    try {
      mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
    } catch (error) {
      console.log(`[MCPManager] Error reading mcp.json: ${error.message}`);
      return;
    }

    const servers = mcpConfig.mcpServers || {};

    // Filter to only real, enabled servers with valid auth
    const enabledServers = Object.entries(servers).filter(
      ([name, cfg]) => {
        if (name.startsWith("_comment") || typeof cfg !== "object" || cfg.enabled === false) return false;

        // Validate auth: skip servers with placeholder or empty credentials
        if (cfg.env) {
          const hasPlaceholder = Object.entries(cfg.env).some(([, v]) =>
            typeof v === "string" && (
              v === "" ||
              v.startsWith("YOUR_") ||
              v === "your-token-here" ||
              v === "your-key-here" ||
              /^[A-Z_]+$/.test(v) // e.g. "GITHUB_TOKEN" as a value, not a reference
            )
          );
          if (hasPlaceholder) {
            console.log(`[MCPManager] Skipping "${name}" - env vars contain placeholder/empty values. Set real credentials.`);
            return false;
          }
        }

        if (cfg.headers) {
          const expandedHeaders = Object.entries(cfg.headers).map(([k, v]) => {
            if (typeof v === "string") {
              return [k, v.replace(/\$\{([^}]+)\}/g, (_, envName) => process.env[envName] ?? "")];
            }
            return [k, v];
          });
          const hasEmpty = expandedHeaders.some(([, v]) => typeof v === "string" && v.trim() === "");
          const hasPlaceholder = expandedHeaders.some(([, v]) =>
            typeof v === "string" && (v.includes("YOUR_") || v === "Bearer " || v === "Bearer")
          );
          if (hasEmpty || hasPlaceholder) {
            console.log(`[MCPManager] Skipping "${name}" - headers resolve to empty/placeholder values. Set env vars.`);
            return false;
          }
        }

        return true;
      }
    );

    if (enabledServers.length === 0) {
      console.log(`[MCPManager] No MCP servers enabled`);
      return;
    }

    console.log(
      `[MCPManager] Connecting to ${enabledServers.length} server(s) in background...`
    );

    // Connect all servers in parallel, non-blocking
    const connectAll = Promise.allSettled(
      enabledServers.map(async ([serverName, serverConfig]) => {
        const tools = await this.connectServer(serverName, serverConfig);
        return { name: serverName, toolCount: tools.length };
      })
    );

    // Don't block startup - log results when ready
    connectAll.then((results) => {
      const succeeded = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r) => r.status === "rejected");

      for (const f of failed) {
        console.log(`[MCPManager] Failed to connect: ${f.reason?.message || f.reason}`);
      }

      console.log(
        `[MCPManager] Ready - ${succeeded.length}/${enabledServers.length} servers, ${this.toolMap.size} tools`
      );
    });
  }

  /**
   * Get all MCP tools as functions + descriptions for the tool registry.
   * Returns { functions: { name: fn }, descriptions: [string] }
   */
  getToolsForAgent() {
    const functions = {};
    const descriptions = [];

    for (const [fullName, entry] of this.toolMap) {
      // Create a wrapper function that calls the MCP tool
      functions[fullName] = async (...args) => {
        // Parse args: first arg is JSON string of arguments
        let toolArgs = {};
        if (args[0]) {
          try {
            toolArgs = typeof args[0] === "string" ? JSON.parse(args[0]) : args[0];
          } catch {
            // If not JSON, try to map positionally based on schema
            const props = entry.inputSchema?.properties || {};
            const keys = Object.keys(props);
            toolArgs = {};
            for (let i = 0; i < keys.length && i < args.length; i++) {
              toolArgs[keys[i]] = args[i];
            }
          }
        }

        console.log(
          `      [MCP:${fullName}] Calling with: ${JSON.stringify(toolArgs).slice(0, 200)}`
        );
        try {
          const result = await entry.client.callTool(entry.toolName, toolArgs);
          return result;
        } catch (error) {
          return `MCP tool error: ${error.message}`;
        }
      };

      // Build description
      const schema = entry.inputSchema?.properties || {};
      const params = Object.entries(schema)
        .map(([k, v]) => `${k}: ${v.type || "any"}`)
        .join(", ");
      descriptions.push(
        `${fullName}(argsJson: string) - [MCP] ${entry.description || entry.toolName}. Params as JSON: {${params}}`
      );
    }

    return { functions, descriptions };
  }

  /**
   * Get built-in tools merged with all connected MCP tools.
   * Called fresh at each task execution - always reflects current connection state.
   * @param {object} builtinTools - The base toolFunctions map
   * @returns {object} Merged tool functions map
   */
  getMergedTools(builtinTools) {
    if (this.toolMap.size === 0) return builtinTools;
    const { functions } = this.getToolsForAgent();
    return { ...builtinTools, ...functions };
  }

  /**
   * Get MCP tool descriptions for the system prompt.
   * Returns empty string if no MCP servers connected.
   */
  getToolDocs() {
    if (this.toolMap.size === 0) return "";

    const lines = ["## MCP Server Tools\n"];
    lines.push("These tools come from connected MCP servers. All params passed as a JSON string.");
    lines.push("");

    // Group by server
    const byServer = new Map();
    for (const [fullName, entry] of this.toolMap) {
      const serverName = fullName.split("__")[1];
      if (!byServer.has(serverName)) byServer.set(serverName, []);
      byServer.get(serverName).push({ fullName, entry });
    }

    for (const [serverName, tools] of byServer) {
      lines.push(`### Server: ${serverName}`);
      for (const { fullName, entry } of tools) {
        const schema = entry.inputSchema?.properties || {};
        const required = entry.inputSchema?.required || [];
        const params = Object.entries(schema)
          .map(([k, v]) => `${k}${required.includes(k) ? "" : "?"}: ${v.type || "any"}`)
          .join(", ");
        const desc = entry.description || entry.toolName;
        lines.push(`#### ${fullName}(argsJson: string)`);
        lines.push(`${desc}`);
        if (params) lines.push(`- argsJson: {${params}}`);
        lines.push("");
      }
    }

    return lines.join("\n");
  }

  /**
   * Get callable tool functions for a specific MCP server only.
   * Used by MCPAgentRunner to give specialist agents only their server's tools.
   * @param {string} serverName - e.g. "github"
   * @returns {object} { "mcp__server__tool": fn, ... }
   */
  getServerTools(serverName) {
    const prefix = `mcp__${serverName}__`;
    const serverTools = {};

    for (const [fullName, entry] of this.toolMap) {
      if (!fullName.startsWith(prefix)) continue;

      serverTools[fullName] = async (...args) => {
        let toolArgs = {};
        if (args[0]) {
          try {
            toolArgs = typeof args[0] === "string" ? JSON.parse(args[0]) : args[0];
          } catch {
            const props = entry.inputSchema?.properties || {};
            const keys = Object.keys(props);
            toolArgs = {};
            for (let i = 0; i < keys.length && i < args.length; i++) {
              toolArgs[keys[i]] = args[i];
            }
          }
        }
        console.log(`      [MCP:${fullName}] Calling with: ${JSON.stringify(toolArgs).slice(0, 200)}`);
        try {
          return await entry.client.callTool(entry.toolName, toolArgs);
        } catch (error) {
          return `MCP tool error: ${error.message}`;
        }
      };
    }

    return serverTools;
  }

  /**
   * Get info about all connected servers - used for system prompt listing.
   * @returns {Array<{name, toolCount, toolNames}>}
   */
  getConnectedServersInfo() {
    const configServers = this.readConfig().mcpServers || {};
    return [...this.clients.entries()]
      .filter(([, client]) => client.connected)
      .map(([name, client]) => ({
        name,
        description: configServers[name]?.description || "",
        toolCount: client.getTools().length,
        toolNames: client.getTools().map((t) => t.name),
      }));
  }

  /**
   * Disconnect all servers.
   */
  async shutdown() {
    for (const [name, client] of this.clients) {
      await client.disconnect();
    }
    this.clients.clear();
    this.toolMap.clear();
  }

  /**
   * List connected servers and tools.
   */
  list() {
    return [...this.clients.entries()].map(([name, client]) => ({
      name,
      connected: client.connected,
      tools: client.getTools().map((t) => t.name),
    }));
  }
}

const mcpManager = new MCPManager();
export default mcpManager;
