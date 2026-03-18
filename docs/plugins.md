# Plugins

Plugins extend Daemora with custom tools, channels, hooks, and services.

## Structure

Every plugin is a folder in `plugins/` with a manifest:

```
plugins/
  my-plugin/
    plugin.json        — manifest (required)
    index.js           — registration code (optional)
    tools/             — auto-discovered tool files
    skills/            — auto-discovered skill files
    profiles/          — auto-discovered agent profiles
```

## Manifest (plugin.json)

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "provides": {
    "tools": ["tools/*.js"],
    "skills": ["skills/*.md"],
    "profiles": ["profiles/*.yaml"]
  },
  "config": {
    "API_KEY": { "type": "secret", "required": true, "label": "API Key" },
    "REGION": { "type": "string", "default": "us-east-1", "label": "Region" }
  },
  "profiles": ["coder", "researcher"],
  "tenantPlans": ["pro", "admin"],
  "agentScope": ["main", "sub-agent"]
}
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique plugin identifier |
| `name` | Yes | Display name |
| `version` | No | Semantic version |
| `description` | No | What the plugin does |
| `provides` | No | Glob patterns for auto-discovery |
| `config` | No | Configuration fields (rendered in UI) |
| `profiles` | No | Append plugin tools to these existing profiles |
| `tenantPlans` | No | Restrict to tenant plans: free, pro, admin |
| `agentScope` | No | Restrict to agent types: main, sub-agent, team |

## Registration (index.js)

```js
export default {
  id: "my-plugin",
  name: "My Plugin",

  register(api) {
    // Register a tool
    api.registerTool("myTool", myFunction, schema, "description");

    // Register a channel
    api.registerChannel("mychannel", MyChannelClass);

    // Lifecycle hooks
    api.on("task:end", (data) => { /* after every task */ });
    api.on("cron:completed", (data) => { /* after cron job */ });

    // Background service
    api.registerService({
      id: "my-service",
      start: async () => { /* init */ },
      stop: async () => { /* cleanup */ },
    });

    // CLI command
    api.registerCli("my-command", (args) => { /* handler */ });

    // HTTP route (prefixed: /api/plugins/my-plugin/...)
    api.registerRoute("GET", "/status", handler);

    // Read plugin config
    const key = api.config("API_KEY");

    // Tenant-aware access
    const tenantConfig = api.getTenantConfig(tenantId);
    const tenantKeys = api.getTenantKeys(tenantId);
  }
};
```

## Installing Plugins

### From npm
```bash
daemora plugin install daemora-plugin-weather
```
Or via dashboard: **Plugins** → enter package name → **Install**.

### Manual
Drop a folder in `plugins/` with a `plugin.json`. Restart or reload.

### From UI
Dashboard → **Plugins** → npm install input → **Install** button.

## Managing Plugins

### CLI
```bash
daemora plugin list          # show all plugins
daemora plugin reload <id>   # hot-reload
daemora plugin reload-all    # reload everything
daemora plugin remove <id>   # uninstall
```

### Dashboard
**Plugins** page:
- Toggle enable/disable per plugin
- Click gear icon to configure API keys
- Click reload to hot-reload
- Click trash to uninstall
- "Needs config" warning shows missing required keys

## Per-Tenant Plugins

Admins can enable/disable plugins per tenant:

Dashboard → **Tenants** → **Edit** → scroll to **Plugins** section → toggle per plugin + enter tenant-specific API keys.

When a plugin is disabled for a tenant, its tools don't appear in that tenant's agent sessions.

## Bundled Plugins

Daemora ships with 6 bundled plugins:

| Plugin | Tools | Config Required |
|--------|-------|----------------|
| **Google Services** | calendar, contacts, googlePlaces | Calendar API Key, Places API Key |
| **Smart Home** | philipsHue, sonos | Hue Bridge IP, Hue API Key |
| **Notifications** | notification | ntfy Server URL |
| **iMessage** | iMessageTool | None (macOS only) |
| **SSH Remote** | sshTool | Default SSH Host |
| **Database Connector** | database | PostgreSQL URL |

## Auto-Discovery

If `plugin.json` has `provides` globs, tools/skills/profiles are auto-loaded:

- `tools/*.js` — each file exports a default function, registered as a tool
- `skills/*.md` — loaded into the skill system
- `profiles/*.yaml` — loaded as agent profiles

## Profile Auto-Append

If `plugin.json` has `profiles: ["coder", "researcher"]`, the plugin's tools are automatically appended to those profiles' tool lists. Sub-agents with those profiles get the plugin tools.
