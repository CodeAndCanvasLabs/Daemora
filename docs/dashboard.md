# Dashboard

The web dashboard runs at `http://localhost:8081` when the server is started.

## Pages

### Dashboard (Home)
Overview of system status — active channels, recent tasks, model info, daemon status.

### Chat
Conversational interface to interact with Daemora. Create new sessions, send tasks, view responses. Sessions persist across page reloads.

Features:
- New Chat button — starts a fresh session
- Session list — switch between conversations
- Delete sessions — removes all related tasks, messages, and cost entries

### Logs
Execution history for all tasks. Shows:
- Task status (pending, running, completed, failed)
- Duration, model used, tool calls, cost
- Expandable details with sub-agent information
- Filter by status

### Channels
View all 20 supported channels with connection status (active/offline). Shows which channels are connected and running.

### MCP
Manage Model Context Protocol servers. Add, activate, sync, or remove MCP servers. Shows active tools per server and credential status.

### Skills
View all 52 built-in skills with descriptions. Skills are domain-specific instructions that guide the agent for specialized tasks (coding, research, email, etc.). Reload button refreshes skill embeddings.

### Cron
Scheduled task management with three tabs:

**Jobs** — create, enable/disable, force-run, delete cron jobs. Schedule types:
- Cron expression (e.g. `0 9 * * *` — daily at 9am)
- Fixed interval (e.g. `30m`, `2h`)
- One-shot (specific date/time)

**Run History** — execution logs with status, duration, delivery status, errors.

**Presets** — delivery presets for multi-tenant delivery. Create named groups (e.g. "engineers", "team-leads") with tenant/channel selections. Jobs deliver results to all targets in a preset.

Delivery modes:
- None — no delivery
- Preset — deliver to a saved group
- Multi-Target — pick specific tenants and channels
- Webhook — POST results to a URL

### Security
12-layer security architecture overview. Shows status of:
- Permission tiers (minimal/standard/full)
- Filesystem sandbox
- Secret vault
- Command guard
- Audit log
- And more

### Costs
Cost tracking per task and per tenant. Shows daily spend, token usage, model breakdown.

### Tenants
Multi-tenant management. Create, edit, suspend, delete tenants.

**Tenant edit modal includes:**
- Plan selection (free/pro/admin)
- Cost limits (per-task, daily)
- Allowed/blocked paths
- Allowed/blocked tools
- MCP server allowlist
- Model routing (default + sub-agent model)
- Channel credentials (WhatsApp, LINE, etc.)
- Private MCP servers
- Plugin enable/disable with config fields
- Notes

### Plugins
Plugin management page. Shows installed plugins with status.

Features:
- Install from npm — enter package name, click Install
- Enable/disable toggle per plugin
- Reload button — hot-reload without restart
- Uninstall button — removes plugin folder
- Config editor — settings gear icon opens config dialog for plugins with configurable fields
- "Needs config" warning — amber badge for plugins missing required API keys
- Status badges: active (green), needs config (amber), disabled (gray), error (red)

### Settings
Global configuration for the agent.

**Global Config:**
- Default model selector
- Permission tier
- Transcription model (STT)
- Speech model (TTS)
- TTS voice selection
- Meeting LLM
- Ollama base URL
- Max cost per task / daily cost limits
- Active channels status
- Daemon mode status

**Secret Vault:**
- Unlock/lock encrypted storage
- AES-256-GCM encryption

**Sub-Agent Model:**
- Model used for spawning sub-agents

**Custom Skills:**
- Create markdown-based skills
- Name, description, triggers, content

**Agent Memory:**
- Persistent instructions the agent reads at the start of every task

**AI Provider Keys:**
- OpenAI, Anthropic, Google, xAI, DeepSeek, Mistral, Groq, OpenRouter
- Encrypted in vault when unlocked

**Global Channels:**
- Telegram, Discord, Slack, WhatsApp, LINE, Email, Signal, Teams, Google Chat
- Enter tokens/credentials per channel

**Tool Config:**
- ElevenLabs, Google Places, Google Calendar, Philips Hue, Sonos, Database, ntfy, Pushover
