# Getting Started

## What is Daemora?

Daemora is a self-hosted AI agent platform that runs on your machine. It connects to your messaging apps (Telegram, Discord, Slack, WhatsApp, Email, and 15+ more), accepts tasks in plain language, executes them autonomously with 46 built-in tools + plugins, and reports back.

## Requirements

- **Node.js** 22 or later
- **pnpm** (recommended) or npm
- At least one AI provider API key (OpenAI, Anthropic, Google, etc.)

## Installation

```bash
# Install globally
npm install -g daemora

# Or with pnpm
pnpm add -g daemora
```

## Quick Setup

```bash
# Run the interactive setup wizard
daemora setup
```

The wizard walks you through:
1. **AI Provider** — choose and enter your API key (OpenAI, Anthropic, Google, xAI, DeepSeek, Mistral, Groq, OpenRouter, Ollama)
2. **Default Model** — select your preferred model
3. **Channels** — connect Telegram, Discord, Slack, WhatsApp, Email, or others
4. **Security** — set permission tier (minimal, standard, full)
5. **Vault** — encrypt your API keys with a passphrase
6. **Tool Keys** — configure OpenAI for images/TTS, ElevenLabs for premium voices
7. **Daemon Mode** — optionally run as a system service (auto-start on boot)
8. **Multi-Tenant** — enable if running for a team
9. **MCP Servers** — connect external tool servers (GitHub, Notion, etc.)

## Start the Server

```bash
daemora start
```

The server starts on `http://localhost:8081` with the web dashboard.

## First Task

Open the dashboard at `http://localhost:8081` → **Chat** → type your request:

```
Research the latest AI news and write a summary
```

Daemora will autonomously research, synthesize, and deliver the result.

## Next Steps

- [CLI Commands](/cli) — full command reference
- [Dashboard](/dashboard) — web UI guide
- [Channels](/channels) — connect messaging apps
- [Plugins](/plugins) — extend with custom tools
- [Multi-Tenant](/multi-tenant) — team deployment
- [Security](/security) — vault, permissions, sandboxing
