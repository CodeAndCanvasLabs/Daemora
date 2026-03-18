# Multi-Tenant

Run one Daemora instance for your entire team. Each tenant (user) gets isolated memory, cost tracking, API keys, channels, and tool access.

## Enable Multi-Tenant

```bash
daemora setup
# Step 8: Enable multi-tenant mode
```

Or set in `.env`:
```bash
MULTI_TENANT_ENABLED=true
AUTO_REGISTER_TENANTS=true
```

## How It Works

When a user messages Daemora on any channel (Telegram, Discord, Slack, etc.), they're automatically registered as a tenant. Their tenant ID is derived from the channel: `telegram:123456789`, `discord:user123`, etc.

Each tenant gets:
- **Isolated memory** — `data/tenants/<id>/MEMORY.md` + daily logs
- **Own API keys** — encrypted per-tenant (AES-256-GCM)
- **Cost tracking** — per-tenant daily budgets
- **Tool allowlist/blocklist** — restrict which tools a tenant can use
- **Filesystem sandbox** — allowed/blocked paths
- **Channel instances** — per-tenant bot tokens
- **Plugin toggles** — enable/disable plugins per tenant
- **Model routing** — per-tenant default + sub-agent models
- **MCP servers** — private MCP server allowlist

## Tenant Plans

Three tiers:
- **free** — default, limited plugins/tools
- **pro** — more plugins, higher budgets
- **admin** — full access, all plugins

Set via CLI:
```bash
daemora tenant plan telegram:123 pro
```

Or via dashboard: **Tenants** → **Edit** → **Plan** dropdown.

## Per-Tenant API Keys

Each tenant can use their own AI provider keys:

```bash
daemora tenant apikey set telegram:123 OPENAI_API_KEY sk-...
daemora tenant apikey set telegram:123 ANTHROPIC_API_KEY sk-ant-...
```

Keys are encrypted with AES-256-GCM. When a tenant sends a task, their keys are used instead of the global ones.

## Per-Tenant Channels

Each tenant can have their own bot tokens:

Dashboard → **Tenants** → **Edit** → enter WhatsApp/Telegram/Discord credentials.

This creates a dedicated channel instance for that tenant — separate bot, separate conversations.

## Per-Tenant Plugins

Dashboard → **Tenants** → **Edit** → **Plugins** section → toggle per plugin + configure API keys.

When a plugin is disabled for a tenant, its tools are invisible to that tenant's agent.

## Cost Limits

Set per-tenant spending caps:
```bash
# Via dashboard: Tenants → Edit → Max Cost / Task, Max Daily Cost
```

When a tenant exceeds their daily budget, tasks are rejected until the next day.

## Admin Detection

The admin is the user who set up Daemora — identified by having no tenant ID (HTTP/UI access). Admin can:
- Create/edit/delete tenants
- Configure global settings
- Manage all plugins
- Create delivery presets for cron jobs
- Access all channels
