import mcpManager from "../mcp/MCPManager.js";

/**
 * Strip credentials from an MCP server config object before it can reach agent output.
 * env contains API keys (GITHUB_TOKEN etc.), headers contains Bearer tokens.
 * We replace values with "[REDACTED]" rather than deleting keys so the agent can see
 * which credential fields are configured without seeing the actual values.
 */
function _stripCredentials(serverConfig) {
  if (!serverConfig || typeof serverConfig !== "object") return serverConfig;
  const safe = { ...serverConfig };
  if (safe.env && typeof safe.env === "object") {
    safe.env = Object.fromEntries(Object.keys(safe.env).map(k => [k, "[REDACTED]"]));
  }
  if (safe.headers && typeof safe.headers === "object") {
    safe.headers = Object.fromEntries(Object.keys(safe.headers).map(k => [k, "[REDACTED]"]));
  }
  return safe;
}

/**
 * manageMCP - inspect, add, remove, and reload MCP server connections at runtime.
 *
 * Actions:
 *   list    - all configured servers and their tool names
 *   tools   - full tool list with descriptions for a specific server
 *   status  - connection status summary (same as list)
 *   add     - add a new MCP server (saved to config/mcp.json + connected immediately)
 *   remove  - disconnect and remove a server from config
 *   enable  - enable a disabled server (reconnects it)
 *   disable - disable a server (disconnects it, keeps in config)
 *   reload  - reconnect a server (useful after config changes)
 */
export async function manageMCP(toolParams) {
  const action = toolParams?.action;
  const paramsJson = toolParams?.params;
  const params = paramsJson
    ? (typeof paramsJson === "string" ? JSON.parse(paramsJson) : paramsJson)
    : {};

  switch (action) {

    case "list":
    case "status": {
      // Show both connected and configured-but-disabled servers
      const connected = mcpManager.list();
      const allConfig = mcpManager.readConfig().mcpServers || {};
      const configuredNames = Object.keys(allConfig).filter(k => !k.startsWith("_comment"));

      if (configuredNames.length === 0 && connected.length === 0) {
        return "No MCP servers configured. Use manageMCP(\"add\", {...}) to add one.";
      }

      const lines = [];
      for (const name of configuredNames) {
        const cfg = _stripCredentials(allConfig[name]);
        const live = connected.find(s => s.name === name);
        if (cfg.enabled === false) {
          lines.push(`⏸️  disabled  ${name}`);
        } else if (live?.connected) {
          const toolList = live.tools.length > 0 ? live.tools.join(", ") : "(no tools)";
          lines.push(`✅ connected ${name}: ${live.tools.length} tools - ${toolList}`);
        } else {
          lines.push(`❌ disconnected ${name}`);
        }
      }
      // Any live servers not in config (shouldn't happen, but just in case)
      for (const s of connected) {
        if (!configuredNames.includes(s.name)) {
          lines.push(`✅ connected ${s.name}: ${s.tools.length} tools (not in config)`);
        }
      }

      return lines.join("\n");
    }

    case "tools": {
      const { server } = params;
      const servers = mcpManager.list();
      if (!server) {
        const all = servers.flatMap(s =>
          s.tools.map(t => `mcp__${s.name}__${t}`)
        );
        if (all.length === 0) return "No MCP tools available. Connect servers first.";
        return `All MCP tools (${all.length}):\n${all.map(t => `  ${t}`).join("\n")}`;
      }
      const srv = servers.find(s => s.name === server);
      if (!srv) return `Server "${server}" not found or not connected. Use manageMCP("list") to see servers.`;
      if (srv.tools.length === 0) return `No tools from server "${server}".`;
      return `Tools from ${server}:\n${srv.tools.map(t => `  mcp__${server}__${t}`).join("\n")}`;
    }

    case "add": {
      const { name, command, args, url, transport, env, headers } = params;
      if (!name) return "Error: name is required";
      if (!command && !url) return "Error: either 'command' (stdio) or 'url' (HTTP/SSE) is required";

      const serverConfig = {};
      if (command) {
        // stdio - credentials go as env vars injected into the subprocess
        serverConfig.command = command;
        if (args) serverConfig.args = args;
        if (env) serverConfig.env = env;   // { "GITHUB_TOKEN": "ghp_..." }
      } else {
        // http/sse - credentials go as HTTP request headers
        serverConfig.url = url;
        if (transport) serverConfig.transport = transport;  // "sse" or omit for HTTP
        if (headers) serverConfig.headers = headers;        // { "Authorization": "Bearer ${TOKEN}" }
      }

      try {
        return await mcpManager.addServer(name, serverConfig);
      } catch (err) {
        return `Error adding server "${name}": ${err.message}`;
      }
    }

    case "remove": {
      const { name } = params;
      if (!name) return "Error: name is required";
      try {
        return await mcpManager.removeServer(name);
      } catch (err) {
        return `Error removing server "${name}": ${err.message}`;
      }
    }

    case "enable": {
      const { name } = params;
      if (!name) return "Error: name is required";
      try {
        return await mcpManager.setEnabled(name, true);
      } catch (err) {
        return `Error enabling server "${name}": ${err.message}`;
      }
    }

    case "disable": {
      const { name } = params;
      if (!name) return "Error: name is required";
      try {
        return await mcpManager.setEnabled(name, false);
      } catch (err) {
        return `Error disabling server "${name}": ${err.message}`;
      }
    }

    case "reload": {
      const { name } = params;
      if (!name) return "Error: name is required";
      try {
        return await mcpManager.reloadServer(name);
      } catch (err) {
        return `Error reloading server "${name}": ${err.message}`;
      }
    }

    default:
      return `Unknown action: "${action}". Valid actions: list, tools, status, add, remove, enable, disable, reload`;
  }
}

export const manageMCPDescription =
  `manageMCP(action: string, paramsJson?: string) - Manage MCP server connections at runtime. Changes saved to config/mcp.json.
  Actions:
    list/status  - no params - all servers with connection status and tool names
    tools        - {"server":"github"} - full tool list for a server, or {} for all servers
    add          - Add and immediately connect a server:
                   stdio (auth via env vars passed to subprocess):
                     {"name":"github","command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":{"GITHUB_PERSONAL_ACCESS_TOKEN":"ghp_..."}}
                   HTTP (auth via Authorization/custom request headers):
                     {"name":"myapi","url":"https://api.example.com/mcp","headers":{"Authorization":"Bearer \${MY_TOKEN}"}}
                   SSE (auth via request headers, applied to both GET stream and POST calls):
                     {"name":"myapi","url":"https://api.example.com/sse","transport":"sse","headers":{"Authorization":"Bearer \${MY_TOKEN}","X-API-Key":"\${MY_KEY}"}}
                   Header values support \${VAR_NAME} - expanded from process.env at connect time.
    remove       - {"name":"github"} - disconnect and remove from config
    enable       - {"name":"github"} - re-enable a disabled server (reconnects)
    disable      - {"name":"github"} - disconnect and mark disabled in config
    reload       - {"name":"github"} - reconnect (useful after editing config)`;
