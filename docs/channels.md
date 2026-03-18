# Channels

Daemora supports 20 messaging channels. Each channel runs as an independent listener that receives messages, creates tasks, and delivers responses.

## Supported Channels

| Channel | Auth Required | Features |
|---------|--------------|----------|
| **HTTP** | Auth token | Web API + dashboard chat |
| **Telegram** | Bot token | Long messages, voice notes, file sharing, approval flows |
| **WhatsApp** | Twilio SID + token | Voice transcription, file attachments |
| **Discord** | Bot token | Slash commands, DMs, reactions, voice transcription |
| **Slack** | Bot + App token | Channels, DMs, emoji reactions, per-channel model |
| **Email** | SMTP/IMAP or Resend | Full email conversations, attachments |
| **LINE** | Channel token + secret | Webhook-based messaging |
| **Signal** | signal-cli URL + phone | End-to-end encrypted, most private channel |
| **Teams** | App ID + password | DMs, channels, file attachments |
| **Google Chat** | Service account | Spaces, DMs, per-channel model |
| **Matrix** | Access token | Federated, self-hostable |
| **Mattermost** | Bot token | Self-hosted Slack alternative |
| **Twitch** | OAuth token | Chat commands, allowlist-gated |
| **IRC** | Server + channel | Classic IRC integration |
| **iMessage** | macOS only | AppleScript-based, no API key needed |
| **Feishu** | App ID + secret | Lark/Feishu integration |
| **Zalo** | App + secret | Vietnamese messaging platform |
| **Nostr** | Private key | Decentralized protocol |
| **NextCloud** | Server URL + token | NextCloud Talk integration |
| **BlueBubbles** | Server URL | iMessage bridge for non-Mac |

## Setup

### Via Setup Wizard
```bash
daemora setup
# Step 3 walks through channel configuration
```

### Via Settings UI
Open dashboard → **Settings** → scroll to **Global Channels** → enter credentials → Save.

### Via CLI
```bash
daemora channels add telegram
# Interactive prompts for token
```

### Via Environment Variables
Add to `.env`:
```bash
TELEGRAM_BOT_TOKEN=your-bot-token
DISCORD_BOT_TOKEN=your-bot-token
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

## Per-Tenant Channels

Each tenant can have their own channel instances with separate bot tokens. Configure in **Tenants** → **Edit** → channel credentials.

This allows:
- Different Telegram bots per tenant
- Separate WhatsApp numbers per tenant
- Isolated Discord servers per tenant

## Allowlists

Restrict which users can interact with the agent:

```bash
TELEGRAM_ALLOWLIST=123456789,987654321
DISCORD_ALLOWLIST=user1,user2
```

Empty allowlist = open to everyone. Set in `.env` or Settings UI.

## Per-Channel Model

Each channel can use a different AI model:

```bash
TELEGRAM_MODEL=openai:gpt-4o-mini
DISCORD_MODEL=anthropic:claude-sonnet-4-20250514
```
