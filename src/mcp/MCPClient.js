import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Expand ${VAR_NAME} patterns in string values using process.env.
 * Works recursively on objects: values only, keys are left untouched.
 *
 * This lets users write:
 *   "Authorization": "Bearer ${MY_API_TOKEN}"
 *   "url": "https://api.example.com/${TENANT_ID}/mcp"
 * without storing the actual secret in mcp.json.
 */
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

/**
 * MCP Client - connects to a single MCP server.
 *
 * Supports three transports:
 *
 *   stdio  - local subprocess. Auth via `env` (merged into process.env for the child).
 *            config: { command, args, env }
 *
 *   http   - Streamable HTTP (MCP 2025-03-26 spec). Auth via `headers`.
 *            config: { url, headers: { "Authorization": "Bearer ${TOKEN}", ... } }
 *
 *   sse    - Legacy SSE transport. Auth via `headers` (applied to both the SSE GET
 *            stream and POST calls). Prefer http for new servers.
 *            config: { url, transport: "sse", headers: { "Authorization": "Bearer ${TOKEN}", ... } }
 *
 * Header values support ${VAR_NAME} expansion from process.env at connect time.
 */
export class MCPClient {
  constructor(name, serverConfig) {
    this.name = name;
    this.serverConfig = serverConfig;
    this.client = null;
    this.transport = null;
    this.tools = [];
    this.connected = false;
  }

  /**
   * Connect to the MCP server.
   */
  async connect() {
    try {
      this.client = new Client(
        { name: `daemora-${this.name}`, version: "1.0.0" },
        { capabilities: { tools: {} } }
      );

      this.transport = this.createTransport();
      await this.client.connect(this.transport);
      this.connected = true;

      const toolsResult = await this.client.listTools();
      this.tools = toolsResult.tools || [];

      console.log(
        `[MCP:${this.name}] Connected - ${this.tools.length} tools: ${this.tools.map((t) => t.name).join(", ")}`
      );

      return this.tools;
    } catch (error) {
      console.log(`[MCP:${this.name}] Connection failed: ${error.message}`);
      this.connected = false;
      return [];
    }
  }

  /**
   * Create the transport based on config.
   *
   * stdio  → StdioClientTransport  - env vars merged into subprocess environment
   * sse    → SSEClientTransport    - headers in requestInit + eventSourceInit
   * http   → StreamableHTTPClientTransport - headers in requestInit
   */
  createTransport() {
    const cfg = this.serverConfig;

    // ── stdio ─────────────────────────────────────────────────────────────────
    if (cfg.command) {
      return new StdioClientTransport({
        command: cfg.command,
        args: cfg.args || [],
        // Env vars are merged into the child process environment.
        // Values support ${VAR} expansion so users can reference existing env vars.
        env: { ...process.env, ...expandEnvVars(cfg.env || {}) },
      });
    }

    if (!cfg.url) {
      throw new Error(`Invalid MCP config for ${this.name}: need 'command' (stdio) or 'url' (http/sse)`);
    }

    const url = new URL(expandEnvVars(cfg.url));

    // Expand ${VAR} in header values at connect time.
    // This keeps actual secrets out of mcp.json - store them in .env / vault,
    // reference them as ${MY_SECRET} in the headers config.
    const rawHeaders = cfg.headers || {};
    const headers = expandEnvVars(rawHeaders);

    // ── SSE ───────────────────────────────────────────────────────────────────
    if (cfg.transport === "sse") {
      // requestInit covers POST requests (messages sent to server).
      // eventSourceInit covers the GET SSE stream (messages received from server).
      // Both need the auth headers.
      return new SSEClientTransport(url, {
        requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
        eventSourceInit: Object.keys(headers).length > 0 ? { headers } : undefined,
      });
    }

    // ── Streamable HTTP (default) ─────────────────────────────────────────────
    return new StreamableHTTPClientTransport(url, {
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
    });
  }

  /**
   * Call a tool on this server.
   */
  async callTool(toolName, args) {
    if (!this.connected || !this.client) {
      throw new Error(`MCP server ${this.name} not connected`);
    }

    const result = await this.client.callTool({
      name: toolName,
      arguments: args,
    });

    if (result.content && Array.isArray(result.content)) {
      return result.content
        .map((c) => {
          if (c.type === "text") return c.text;
          if (c.type === "image") return `[Image: ${c.mimeType}]`;
          return JSON.stringify(c);
        })
        .join("\n");
    }

    return JSON.stringify(result);
  }

  /**
   * Disconnect from the server.
   */
  async disconnect() {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // ignore close errors
      }
      this.connected = false;
      console.log(`[MCP:${this.name}] Disconnected`);
    }
  }

  /**
   * Get tool list for this server.
   */
  getTools() {
    return this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }
}
