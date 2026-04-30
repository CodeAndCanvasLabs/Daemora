# Daemora-TS — Full Rewrite Plan

> Replaces the JS backend at `/Users/umarfarooq/Downloads/Personal/p2/src/`
> Goal: production-ready, single-shot AI agent daemon with best practices

---

## Phase 1: Core Engine — DONE
- [x] Config system (vault, settings, schema, env)
- [x] SOUL.md system prompt
- [x] AgentLoop (streaming, tool execution, multi-step, abort)
- [x] ModelRouter (provider resolution, no hardcoded fallbacks)
- [x] SessionStore (SQLite, multi-turn history)
- [x] MemoryStore (FTS5 BM25 recall, tags)
- [x] FilesystemGuard (symlink-safe, denylist, command scan)

## Phase 2: Tools — DONE
- [x] Filesystem: read_file, write_file, edit_file, apply_patch, list_directory, glob, grep, create_document
- [x] Shell: execute_command (guarded)
- [x] Network: fetch_url, web_search (Brave)
- [x] Memory: memory_save, memory_recall
- [x] AI: image_analysis, transcribe_audio, text_to_speech, generate_image
- [x] System: clipboard, screen_capture, reply_to_user
- [x] Channel: send_email (Resend)
- [x] Agent: use_crew, parallel_crew

## Phase 3: Crews — DONE
- [x] CrewLoader (plugin.json validation, tool resolution)
- [x] CrewRegistry (lookup, summary)
- [x] CrewAgentRunner (scoped tools, persistent sessions, model inheritance)
- [x] 16 crew profiles with skills (analyst → ssh-remote)

## Phase 4: Providers — DONE
- [x] Provider catalog (18 providers: LLM + STT + TTS + search)
- [x] Dynamic model discovery via provider APIs (OpenAI, Anthropic, Google, Groq, Ollama, DeepSeek, Mistral, xAI, OpenRouter, Together, Fireworks, Cerebras)
- [x] Static fallback when discovery fails
- [x] Vault schema for all provider keys
- [x] /api/providers endpoint (one call, full landscape)

## Phase 5: Subsystems — DONE
- [x] CostTracker (per-task token costs, daily limits)
- [x] AuditLog (append-only, action types, risk levels)
- [x] CronStore + CronScheduler (expression parser, 30s polling)
- [x] WatcherStore (CRUD, webhook/poll/file/cron triggers)
- [x] GoalStore (CRUD, check scheduling, progress tracking)
- [x] TaskStore (persisted to SQLite, survives restart)
- [x] 59 skills loaded from disk

## Phase 6: MCP + Channels — DONE
- [x] MCPStore (JSON config persistence)
- [x] MCPManager (stdio + HTTP transport, tool discovery, JSON-RPC)
- [x] 22 built-in MCP servers (github, notion, linear, slack, postgres, etc.)
- [x] ChannelRegistry (19 channels: Telegram → Nostr)
- [x] Channel routing table (SQLite)

## Phase 7: Server + UI — DONE
- [x] Express server with all routes
- [x] SSE task streaming (task-based flow matching UI)
- [x] SPA fallback for client-side routing
- [x] UI served from ui/dist
- [x] Compat catch-all for unimplemented endpoints
- [x] All API response shapes matched to UI expectations

---

## Phase 8: Channel Implementations — TODO
- [ ] BaseChannel abstract class (sendReply, sendTyping, isAllowed, getModel)
- [ ] TelegramChannel (webhook + polling, markdown formatting)
- [ ] DiscordChannel (gateway, slash commands, embeds)
- [ ] SlackChannel (socket mode, blocks, threads)
- [ ] WhatsAppChannel (Twilio webhook)
- [ ] EmailChannel (IMAP polling + SMTP/Resend send)
- [ ] Channel message normalization → task queue → response routing

## Phase 9: Teams / Swarm Orchestration — TODO
- [ ] TeamStore (SQLite persistence)
- [ ] TeamRunner (worker DAG, dependency resolution, result passing)
- [ ] createTeam, status, disbandTeam, relaunchProject actions
- [ ] Templates (full-stack, microservices, research)
- [ ] blockedByWorkers dependency chain
- [ ] Auto-inject completed worker results into dependents

## Phase 10: Learning System — TODO
- [ ] ExtractionPipeline (auto-extract patterns from completed tasks)
- [ ] SmartRecall (embedding-based semantic search, not just FTS5)
- [ ] MemoryDecay (age-weight older entries, prune irrelevant)
- [ ] BackgroundReviewer (periodic re-evaluation of stored knowledge)
- [ ] LearningStats (track recall hit rates, extraction quality)

## Phase 11: MCP Client Hardening — TODO
- [ ] Full MCP protocol compliance (resources, prompts, sampling)
- [ ] Reconnect on server crash
- [ ] Tool invocation end-to-end testing
- [ ] MCP tools registered as agent tools (mcp__server__tool)
- [ ] useMCP(serverName, task) sub-agent delegation

## Phase 12: Testing + Quality — TODO
- [ ] Vitest unit tests (config, vault, session, memory, guard, tools)
- [ ] Integration tests (chat flow, crew delegation, SSE streaming)
- [ ] Supertest route tests (all API endpoints)
- [ ] CI pipeline (typecheck + test on push)

## Phase 13: Desktop Bundling — STASHED
- [ ] S2: Python sidecar via PyInstaller (spec written, stashed)
- [ ] S3: Bundle livekit-server binary
- [ ] S5: Smoke test .dmg on clean machine
- [ ] S6: GitHub Actions matrix (Mac + Win + Linux)

## Phase 14: UI Adaptation — TODO
- [ ] Modify UI source to use /api/providers instead of fragmented endpoints
- [ ] Fix remaining UI crashes (Costs toFixed, Cron Users import)
- [ ] Rebuild UI from source after changes
- [ ] Remove old JS-backend-specific code from UI

---

## Architecture

```
agents/daemora-ts/
├── SOUL.md                    # Agent personality
├── PLAN.md                    # This file
├── package.json               # Node 22+, ESM
├── tsconfig.json              # Strict mode
├── crew/                      # 16 crew profiles (plugin.json)
├── skills/                    # 59 skill definitions (.md)
├── ui/                        # Full UI source + dist
├── tests/                     # Vitest tests
└── src/                       # 72 TypeScript source files
    ├── cli/                   # CLI entry + commands
    ├── config/                # ConfigManager, vault, settings, schema
    ├── core/                  # AgentLoop
    ├── crew/                  # CrewLoader, Registry, AgentRunner
    ├── cron/                  # CronStore, Scheduler, parser
    ├── costs/                 # CostTracker
    ├── channels/              # ChannelRegistry
    ├── goals/                 # GoalStore
    ├── integrations/          # (future)
    ├── mcp/                   # MCPStore, MCPManager
    ├── memory/                # SessionStore, MemoryStore
    ├── models/                # ModelRouter, discovery, providers catalog
    ├── safety/                # FilesystemGuard, AuditLog
    ├── server/                # Express app + route modules
    ├── skills/                # SkillLoader, SkillRegistry
    ├── tasks/                 # TaskStore
    ├── tools/                 # 23 core tools
    ├── util/                  # errors, logger, result
    └── watchers/              # WatcherStore
```

## Running

```bash
cd agents/daemora-ts
npm run dev          # tsx watch + auto-restart
npm run start        # production
npm run typecheck    # tsc --noEmit
npm run test         # vitest
```
