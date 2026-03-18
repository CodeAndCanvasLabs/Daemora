# Configuration

## Environment Variables

All configuration can be set via `.env` file, environment variables, or the Settings UI.

### Core Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8081 | Server port |
| `DEFAULT_MODEL` | auto-detected | AI model (e.g. `openai:gpt-4o-mini`) |
| `SUB_AGENT_MODEL` | same as default | Model for sub-agents |
| `PERMISSION_TIER` | standard | minimal, standard, full |
| `MAX_COST_PER_TASK` | 0.50 | Max cost per task in USD |
| `MAX_DAILY_COST` | 10.00 | Max daily cost in USD |
| `THINKING_LEVEL` | auto | off, minimal, low, medium, high, xhigh |
| `QUEUE_MODE` | steer | steer, collect, followup |
| `DAEMON_MODE` | false | Run as background service |

### AI Provider Keys

| Variable | Provider |
|----------|----------|
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic |
| `GOOGLE_AI_API_KEY` | Google AI |
| `XAI_API_KEY` | xAI (Grok) |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `MISTRAL_API_KEY` | Mistral |
| `GROQ_API_KEY` | Groq |
| `OPENROUTER_API_KEY` | OpenRouter |

### Channel Tokens

| Variable | Channel |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram |
| `DISCORD_BOT_TOKEN` | Discord |
| `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` | Slack |
| `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_PHONE_FROM` | WhatsApp + Voice |
| `RESEND_API_KEY` or `EMAIL_USER` + `EMAIL_PASSWORD` | Email |
| `LINE_CHANNEL_ACCESS_TOKEN` + `LINE_CHANNEL_SECRET` | LINE |
| `SIGNAL_CLI_URL` + `SIGNAL_PHONE_NUMBER` | Signal |
| `TEAMS_APP_ID` + `TEAMS_APP_PASSWORD` | Teams |
| `GOOGLE_CHAT_SERVICE_ACCOUNT` | Google Chat |

### Tunneling

| Variable | Description |
|----------|-------------|
| `DAEMORA_PUBLIC_URL` | Production public URL |
| `NGROK_AUTHTOKEN` | ngrok tunnel (dev) |
| `TAILSCALE_MODE` | serve or funnel |

### Multi-Tenant

| Variable | Description |
|----------|-------------|
| `MULTI_TENANT_ENABLED` | Enable multi-tenant mode |
| `AUTO_REGISTER_TENANTS` | Auto-create tenant on first message |
| `TENANT_ISOLATE_FILESYSTEM` | Per-tenant filesystem isolation |
| `AEGIS_TENANT_KEY` | Encryption key for tenant API keys |

## Configuration Priority

1. **Tenant config** (per-tenant overrides) — highest
2. **SQLite config_entries** (saved via Settings UI)
3. **Environment variables** (`.env` file)
4. **Defaults** (hardcoded in `src/config/default.js`)

## Model Routing

Set different models for different purposes:

```bash
DEFAULT_MODEL=openai:gpt-4o-mini        # main agent
SUB_AGENT_MODEL=openai:gpt-4o-mini      # sub-agents
TELEGRAM_MODEL=anthropic:claude-sonnet-4-20250514  # per-channel
```

Per-tenant model routing available in tenant settings.

## Config via CLI

```bash
daemora config set DEFAULT_MODEL openai:gpt-4o-mini
daemora config get DEFAULT_MODEL
```

## Config via Settings UI

Dashboard → **Settings** → **Global Config** → edit fields → **Save**.

All settings saved to SQLite and take effect immediately without restart.
