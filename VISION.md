# Daemora - Vision

## Why Daemora Exists

Every AI assistant today is a chat window. You type, it replies, you close the tab. Nothing happens while you sleep.

Daemora exists because AI should work like an employee - not a chatbot. An employee you give a task to at 10pm, and by morning it's done. An employee that remembers your preferences, respects your budget, and works across every channel you use. An employee you can trust with your API keys because they never leave your infrastructure.

We built Daemora because no one else solved the full problem:
- ChatGPT/Claude - great at thinking, can't do anything autonomously
- n8n/Zapier - great at automation, can't reason or adapt
- AutoGPT/CrewAI - great demos, not production-ready
- OpenClaw - great personal assistant, can't serve a team
- Hermes Agent - learns from experience, but single-user only

Daemora is the AI that actually does things. For your whole team. On your own hardware. And it gets smarter every time it works.

## What We Believe

**AI should run on your infrastructure.** Your data, your keys, your security boundary. No cloud relay. No third-party storage. The only external calls are to the model APIs you choose.

**One deployment should serve many users.** Not one instance per person. One Daemora serves your whole team - each user isolated with their own memory, keys, cost caps, and permissions. The admin controls everything.

**Agents should be autonomous, not assistive.** Daemora doesn't wait for you to hit enter. Give it a cron job at midnight, a team of sub-agents working in parallel, a multi-step research task - it executes while you're not looking. No babysitting.

**Agents should learn from experience.** After complex tasks, Daemora automatically reviews what happened, saves user preferences, and creates reusable skills. The more you use it, the better it gets - without being told to learn.

**Security is not optional.** 16 layers. Encrypted vault. Subprocess isolation. Egress monitoring. Secret redaction. Audit trails. Tenant isolation. If you're running an AI agent that can execute shell commands and send emails, you better have real security - not a checkbox.

**Tools should be first-class.** 59 built-in tools. Browser automation. MCP integration with proper Zod schemas via @ai-sdk/mcp. Crew system with self-contained specialist sub-agents. The agent doesn't just think - it acts.

## Where We're Going

**Phase: Foundation** (done)
- Core agent loop with Vercel AI SDK native tool calling (7 providers, 59+ models)
- Multi-tenant platform with full AsyncLocalStorage isolation
- 20 communication channels
- Production-grade scheduler with delivery, retry, overlap prevention, Morning Pulse
- Persistent Goals - autonomous objective execution 24/7 with auto-pause on failures
- Watchers - event-driven webhook triggers with pattern matching, multi-destination delivery, 8 pre-built templates, project context injection
- Fleet Command - admin broadcast to all tenants simultaneously
- Structured agent contracts (ContractBuilder) for sub-agents and teams
- 16-layer security architecture
- Agent teams with shared tasks, dependencies, and inter-agent messaging
- A2A protocol for inter-agent communication
- Web dashboard (Goals, Watchers, Scheduler, Tenants, Crew, Security, Costs, Settings)

**Phase: Intelligence** (current)
- Crew system - self-contained specialist sub-agents with own tools, profiles, skills, persistent sessions
- Self-improving agent - background review after complex tasks, auto-creates skills and learns user preferences
- MCP integration via @ai-sdk/mcp - proper Zod schemas, native AI SDK tool calling
- Proactive Heartbeat - system health checks (overdue goals, broken cron, silent watchers, failed tasks), HEARTBEAT_OK suppression, timezone-aware active hours
- Watcher templates - 8 pre-built setups (GitHub, Stripe, Uptime, Deploy, Form) with context injection

**Phase: Expansion**
- War Room - live agent tree visualization (active sub-agents, tasks, sessions)
- Smart model routing - per-turn cheap/strong auto-detection, per-profile model assignment
- Shadow Mode - agent reasons but doesn't execute, daily "what I would have done" report
- Audit report PDF export - compliance-ready action trail with date filtering
- Brain export/import - shareable agent configs (memory + goals + watchers + cron + skills)
- Crew marketplace - community-built specialist agents with security scanning

**Phase: Platform**
- Self-service tenant onboarding - users sign up, get their own isolated workspace
- Per-tenant billing - usage-based pricing for managed deployments
- Federated agents - Daemora instances talking to each other via A2A
- Enterprise features - SSO, RBAC, compliance logging, data retention policies
- SDK - build custom agents on top of Daemora's infrastructure

## What We Won't Do

- **We won't go cloud-only.** Self-hosted is the core promise. If we offer a managed version, the self-hosted version stays feature-complete.
- **We won't break multi-tenant isolation.** Every feature must work in a multi-tenant context. Single-user-only features don't ship.
- **We won't sacrifice security for convenience.** If a feature requires weakening security boundaries, it doesn't ship.
- **We won't vendor-lock to one AI provider.** Daemora works with OpenAI, Anthropic, Google, xAI, DeepSeek, Mistral, Groq, OpenRouter, and Ollama. Switching providers is a config change.
- **We won't become a workflow builder.** Daemora is an autonomous agent, not a drag-and-drop automation tool. The AI decides how to accomplish tasks - you don't draw flowcharts.

## The Name

Daemora - from "daemon," the background process that runs silently and tirelessly. That's exactly what it does. Your AI daemon that never stops working.

---

*Built by [Code & Canvas Labs](https://github.com/CodeAndCanvasLabs)*
