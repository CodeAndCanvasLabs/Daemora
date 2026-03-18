# CLI Commands

## Core Commands

### `daemora start`
Start the Daemora server. Loads all channels, plugins, and tools.

```bash
daemora start
# Server runs on http://localhost:8081
```

On startup:
- Unlocks vault (if configured) — prompts for passphrase
- Loads 52 skills + embeddings
- Loads plugins from `plugins/` directory
- Connects MCP servers
- Starts all configured channels
- Opens cloudflared tunnel (if no public URL configured)

### `daemora setup`
Interactive setup wizard. Guides you through initial configuration:
- AI provider + API key
- Default model selection
- Channel connections
- Security tier
- Vault encryption
- Daemon mode
- Multi-tenant setup
- MCP servers

### `daemora version`
Show installed version.

```bash
daemora version
# or
daemora -v
```

---

## Plugin Management

### `daemora plugin list`
List all installed plugins with status, tools, hooks, and services.

```bash
daemora plugin list
```

Output shows:
- Status: loaded / disabled / error
- Plugin name, version, ID
- Registered tools, channels, hooks, services
- Error details if any

### `daemora plugin install <package>`
Install a plugin from npm.

```bash
daemora plugin install daemora-plugin-weather
```

Installs the npm package into the `plugins/` directory. Restart or reload to activate.

### `daemora plugin remove <id>`
Remove an installed plugin.

```bash
daemora plugin remove weather
```

Deletes the plugin folder. Restart or reload to apply.

### `daemora plugin reload <id>`
Hot-reload a single plugin without restarting the server.

```bash
daemora plugin reload google-services
```

### `daemora plugin reload-all`
Reload all plugins.

```bash
daemora plugin reload-all
```

---

## Tenant Management

### `daemora tenant list`
List all registered tenants with plan, status, and channel connections.

### `daemora tenant create <name>`
Create a new tenant.

### `daemora tenant plan <id> <free|pro|admin>`
Set a tenant's plan tier.

### `daemora tenant suspend <id> [reason]`
Suspend a tenant — blocks all task processing.

### `daemora tenant unsuspend <id>`
Reactivate a suspended tenant.

### `daemora tenant reset <id>`
Reset tenant configuration (keeps cost history).

### `daemora tenant delete <id>`
Permanently delete a tenant record.

### `daemora tenant link <id> <channel> <userId>`
Link a channel identity to a tenant.

### `daemora tenant unlink <id> <channel> <userId>`
Unlink a channel identity.

### `daemora tenant apikey set <id> <KEY> <value>`
Store an encrypted API key for a tenant.

```bash
daemora tenant apikey set telegram:123 OPENAI_API_KEY sk-...
```

### `daemora tenant apikey delete <id> <KEY>`
Delete a tenant's API key.

### `daemora tenant apikey list <id>`
List a tenant's stored key names (not values).

### `daemora tenant channel set <id> <key> <value>`
Store a channel credential for a tenant.

### `daemora tenant channel unset <id> <key>`
Remove a channel credential.

### `daemora tenant channel list <id>`
List stored channel credential keys.

### `daemora tenant workspace <id>`
Show workspace paths (allowed/blocked).

### `daemora tenant workspace <id> add|remove|block|unblock <path>`
Manage workspace path restrictions.

---

## System Management

### `daemora channels`
List all 20 supported channels with setup status.

### `daemora channels add [name]`
Configure a new channel interactively.

### `daemora models`
List all model providers and task-type routing.

### `daemora tools [filter]`
List all built-in tools (filter by name or category).

### `daemora config set <KEY> <value>`
Set a configuration value.

### `daemora config get <KEY>`
Get a configuration value.

### `daemora doctor`
Run security audit — checks for misconfigurations across 8 areas.

### `daemora cleanup`
Delete old tasks, logs, and sessions.

### `daemora cleanup set <days>`
Set auto-cleanup retention period (0 = never delete).

### `daemora cleanup stats`
Show storage usage per directory.

---

## Vault Management

### `daemora vault import <passphrase>`
Import .env keys into encrypted vault and remove from plaintext.

### `daemora vault set <passphrase> <KEY> <value>`
Store a secret in the vault.

### `daemora vault list <passphrase>`
List all vault key names.

### `daemora vault export <passphrase>`
Export vault keys back to .env.

---

## Daemon Management

### `daemora daemon install`
Install Daemora as a system service (auto-start on boot).
- macOS: LaunchAgent
- Linux: systemd user service
- Windows: Scheduled Task

### `daemora daemon uninstall`
Remove the system service.

### `daemora daemon status`
Check if the daemon is running.

---

## MCP Server Management

### `daemora mcp add <name> <command> [args...]`
Add an MCP server.

```bash
daemora mcp add github npx -y @modelcontextprotocol/server-github
```

### `daemora mcp remove <name>`
Remove an MCP server.

### `daemora mcp list`
List configured MCP servers.
