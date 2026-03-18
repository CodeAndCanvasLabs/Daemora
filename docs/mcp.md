# MCP (Model Context Protocol)

Connect external tool servers to give Daemora access to GitHub, Notion, Linear, databases, and more.

## What is MCP?

MCP servers are external processes that provide tools to the agent. Each server exposes tools that Daemora can call — like a GitHub MCP server that provides `create_issue`, `list_repos`, etc.

## Adding MCP Servers

### Via CLI
```bash
daemora mcp add github npx -y @modelcontextprotocol/server-github
daemora mcp add notion npx -y @modelcontextprotocol/server-notion
daemora mcp add postgres npx -y @modelcontextprotocol/server-postgres
```

### Via Setup Wizard
```bash
daemora setup
# Step 9: MCP Servers
```

### Via Settings UI
Dashboard → **MCP** → enter server name + command → **Add Server**.

## Popular MCP Servers

| Server | Command | Tools |
|--------|---------|-------|
| GitHub | `npx -y @modelcontextprotocol/server-github` | Issues, PRs, repos, branches |
| Notion | `npx -y @modelcontextprotocol/server-notion` | Pages, databases, search |
| Slack | `npx -y @modelcontextprotocol/server-slack` | Channels, messages, users |
| PostgreSQL | `npx -y @modelcontextprotocol/server-postgres` | SQL queries, schema |
| Puppeteer | `npx -y @modelcontextprotocol/server-puppeteer` | Browser automation |

## Per-Tenant MCP

Each tenant can have:
- **Private MCP servers** — only accessible by that tenant
- **MCP allowlist** — restrict which global servers a tenant can use

Configure in **Tenants** → **Edit** → **Private MCP Servers** section.

## MCP in Agent

The agent uses MCP tools via `useMCP`:
```
useMCP(serverName: "github", taskDescription: "Create an issue for the login bug")
```

This spawns a specialist MCP agent with access to that server's tools.

## Transport

MCP servers communicate via stdio (standard input/output). Daemora spawns the server process and communicates through pipes.
