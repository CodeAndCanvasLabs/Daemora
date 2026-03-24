# Building a Crew Member

A crew member is a self-contained specialist sub-agent. It has its own tools, profile (identity + system prompt), skills, and persistent session. The main agent delegates work via `useCrew(crewId, taskDescription)`.

---

## Quick Start

```bash
mkdir crew/my-crew
cd crew/my-crew
```

Three files:

```
crew/my-crew/
├── plugin.json       # manifest
├── index.js          # registration
└── tools/
    └── myTool.js     # tool implementation
```

---

## 1. plugin.json - Manifest

```json
{
  "id": "my-crew",
  "name": "My Crew Member",
  "version": "1.0.0",
  "description": "What this crew member does - shown to the main agent",
  "config": {
    "MY_API_KEY": { "type": "secret", "required": true, "label": "API Key" }
  },
  "profile": {
    "systemPrompt": "You are a specialist in X. Do Y. Follow Z conventions.",
    "temperature": 0.3,
    "model": null
  },
  "skills": ["coding", "data-analysis"]
}
```

### Fields

| Field | Required | Description |
|---|---|---|
| `id` | yes | Unique ID (lowercase, hyphens). Used in `useCrew("my-crew", ...)` |
| `name` | yes | Display name |
| `version` | no | Semver version |
| `description` | yes | One-line description - the main agent sees this to decide when to delegate |
| `config` | no | Required configuration. If missing, crew member shows "needs-config" status |
| `config.*.type` | - | `"secret"` (masked in UI) or `"string"` |
| `config.*.required` | - | If `true`, crew member won't load without this value set |
| `config.*.label` | - | Human-readable label for the UI |
| `profile.systemPrompt` | no | Identity prompt - tells the sub-agent who it is and how to behave |
| `profile.temperature` | no | Model temperature (0.0-1.0). Lower = precise, higher = creative |
| `profile.model` | no | Model override. `null` = use default model |
| `skills` | no | Array of global skill IDs to inject (e.g. `["coding", "devops"]`) |

---

## 2. index.js - Registration

```javascript
import { myTool } from "./tools/myTool.js";
import { z } from "zod";

export default {
  id: "my-crew",
  name: "My Crew Member",

  register(api) {
    api.registerTool("myTool", myTool, z.object({
      action: z.enum(["list", "create", "delete"]).describe("Action to perform"),
      name: z.string().optional().describe("Item name"),
    }), "myTool(action, name?) - Manage items. action: list | create | delete");

    api.log.info("Registered: myTool");
  },
};
```

### api.registerTool(name, fn, schema, description)

| Param | Type | Description |
|---|---|---|
| `name` | string | Tool name - must be unique across all crew members |
| `fn` | function | `async (params) => string` - receives validated params, returns result text |
| `schema` | Zod schema | Zod object schema for parameter validation. Use `z.object({}).passthrough()` for flexible params |
| `description` | string | One-line description shown in tool docs |

### Other api methods

```javascript
api.registerTool(name, fn, schema, description)  // register a tool
api.registerChannel(name, impl)                   // register a channel type
api.registerService(service)                      // background service { id, start(), stop() }
api.registerCli(name, handler)                    // CLI command
api.registerRoute(method, path, handler)          // HTTP route (auto-prefixed /api/crew/<id>/...)
api.on(event, handler)                            // listen to EventBus events
api.config(key)                                   // read plugin config value
api.setConfig(key, value)                         // write plugin config
api.getTenantConfig(tenantId?)                     // read tenant config (current tenant if omitted)
api.getTenantKeys(tenantId?)                       // read tenant API keys (current tenant if omitted)
api.log.info(msg) / .warn(msg) / .error(msg)      // logging
```

---

## 3. tools/myTool.js - Tool Implementation

```javascript
/**
 * myTool - does something useful.
 *
 * @param {object} params - Validated by Zod schema from index.js
 * @returns {string} Result text (shown to the agent)
 */
export async function myTool(params) {
  const action = params?.action || "list";

  switch (action) {
    case "list":
      return "Found 3 items: apple, banana, cherry";

    case "create":
      if (!params.name) return "Error: name is required for create";
      return `Created item: ${params.name}`;

    case "delete":
      if (!params.name) return "Error: name is required for delete";
      return `Deleted item: ${params.name}`;

    default:
      return `Unknown action "${action}". Use: list, create, delete`;
  }
}
```

### Rules

- Always return a string (the agent reads this as the tool result)
- Handle errors gracefully - return error messages, don't throw
- Use `params?.field` (params are pre-validated by Zod but be defensive)
- For API calls, read credentials via environment or `api.config(key)` / `api.getTenantKeys()`

---

## 4. Reading Config & Credentials

Crew members access config via environment variables or the api:

```javascript
// In index.js - read config during registration
register(api) {
  const apiKey = api.config("MY_API_KEY");  // reads from env or config store
  if (!apiKey) {
    api.log.warn("MY_API_KEY not configured");
  }
}

// In tools - read per-tenant keys at runtime
import tenantContext from "../../src/tenants/TenantContext.js";

export async function myTool(params) {
  const store = tenantContext.getStore();
  const apiKey = store?.apiKeys?.MY_API_KEY || process.env.MY_API_KEY;
  // use apiKey...
}
```

Config priority: tenant API keys → env vars → config store → manifest defaults.

---

## 5. How It Works at Runtime

```
User: "Check my database for slow queries"
  ↓
Main agent sees crew member "database-connector" in system prompt
  ↓
Main agent calls: useCrew("database-connector", "Find slow queries, show execution plans")
  ↓
CrewAgentRunner:
  1. Loads crew tools from PluginRegistry
  2. Wraps as AI SDK tool() objects with Zod schemas
  3. Builds system prompt from manifest profile
  4. Loads persistent session (crew:database-connector)
  5. Spawns sub-agent with crew tools + base tools
  ↓
Sub-agent executes: calls database("query", ...), analyzes results
  ↓
Result returned to main agent → delivered to user
```

### Base tools available to every crew member

Every crew sub-agent gets these alongside its own tools:

```
readFile, writeFile, editFile, listDirectory, glob, grep,
executeCommand, webFetch, webSearch, createDocument, replyToUser
```

### Session persistence

Each crew member maintains its own session per user session: `{mainSessionId}--crew:{crewId}`. This means:
- "List my events" → crew member sees the events
- "Delete the 3pm one" → crew member remembers the previous call

---

## 6. Testing

### Test the tool directly

```bash
node -e "
import('./crew/my-crew/tools/myTool.js').then(async ({ myTool }) => {
  console.log(await myTool({ action: 'list' }));
});
"
```

### Test crew loading

```bash
node -e "
import('./src/crew/PluginLoader.js').then(async ({ loadCrew }) => {
  const reg = await loadCrew();
  for (const m of reg.crew) {
    console.log(m.id, '(' + m.status + ')', m.toolNames.join(', '));
  }
});
"
```

### Test via chat

Start the server and ask:
```
Use the my-crew crew to list all items
```

---

## 7. Publishing to npm

```bash
cd crew/my-crew
npm init -y
# Set name to "daemora-crew-my-crew"
npm publish
```

Others install with:
```bash
daemora crew install daemora-crew-my-crew
```

---

## Examples

### Minimal (no config, no API keys)

See `crew/system-monitor/` - checks CPU, memory, disk. Zero dependencies.

### With API keys

See `crew/google-services/` - requires Google API keys. Shows config schema pattern.

### With multiple tools

See `crew/smart-home/` - registers `philipsHue` + `sonos` tools from one crew member.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Crew member shows "needs-config" | Set required config values via Settings UI or env vars |
| Tool not appearing | Check `index.js` exports and `register()` call. Run `daemora crew list` |
| Tool schema errors | Validate your Zod schema matches the params your function expects |
| Crew member not loading | Check `plugin.json` has `id` and `name` fields. Check server logs for errors |
| Hot-reload not working | Run `daemora crew reload` or restart the server |
