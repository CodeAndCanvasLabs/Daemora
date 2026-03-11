# Daemora vs OpenClaw — Full Gap Audit

Where Daemora lacks, what OpenClaw does better, and what to fix. File-indexed.

---

## 1. TOOL SYSTEM — ✅ DONE

### What Was Done
- 54 Zod schemas in `src/tools/schemas.js` — `.describe()` on every field for LLM hints
- Named params: `params: z.record(z.unknown())` in `src/services/models/outputSchema.js`
- All 50+ tool files updated from positional args to single `params` object
- `validateToolParams()` in AgentLoop validates before dispatch
- `buildToolDocLines()` generates one-liner docs from schemas (replaces verbose prose)
- Tool dispatch: `tools[name](params)` instead of `tools[name](...params)`

### Still Missing (P2)
- No custom `ToolInputError` class (uses string returns)
- No provider-specific schema normalization (Gemini/xAI compat)
- Tool results still raw strings (not structured `AgentToolResult`)

---

## 2. SYSTEM PROMPT — ✅ DONE

### What Was Done
- SOUL.md: 211 lines → 74 lines (~897 tokens, was 3,609)
- Removed: Building/Coding, Research, Communication, Memory, Sandbox sections
- Kept: Core Identity, Response Rules, Planning, Verification, Multi-Agent, Security, Engineering, Boundaries
- Made general-purpose (not code-centric)
- renderResponseFormat(): 726 → ~155 tokens
- renderToolList(): one-liner docs from schemas instead of verbose prose
- renderToolUsageRules(): 161 → ~85 tokens
- renderSubagentContext(): 319 → ~71 tokens
- Skills loading triggers restored (planning, orchestration)
- Deduplication: orchestration/planning/memory rules now single source of truth
- **Total: ~8,054 → ~2,713 fixed tokens (66% reduction)**

---

## 3. CONFIG VALIDATION — NO SCHEMA

### Current State (Daemora)
- Raw `process.env` reads with manual `parseInt`/`parseFloat` (`src/config/default.js:22-237`)
- No startup validation — `MAX_DAILY_COST="unlimited"` → `NaN` → silently bypassed
- No required field checks — missing API keys only caught at runtime
- No type coercion safety — `PORT="abc"` → `NaN` → falls back silently

### OpenClaw's Approach
- JSON5/YAML config with Zod schema validation (`openclaw/src/config/types.ts`)
- Auto-migration for legacy config entries
- Issue formatting with helpful error messages
- `openclaw doctor` validates everything at startup

### Gap Summary
| Aspect | Daemora | OpenClaw |
|--------|---------|----------|
| Format | .env (flat key=value) | JSON5/YAML (structured) |
| Validation | None | Zod schema |
| Migration | None | Auto-migration |
| Diagnostics | `daemora doctor` (8 checks) | `openclaw doctor` (comprehensive) |
| Bad value handling | Silent NaN/undefined | Startup error with message |

---

## 4. STORAGE LAYER — FLAT FILES, NO TRANSACTIONS

### Concurrent Write Vulnerabilities
| Component | File | Pattern | Risk |
|-----------|------|---------|------|
| memory.js embeddings | `data/memory/embeddings.json` | read-modify-write (load→add→save) | CRITICAL: lost entries |
| memory.js MEMORY.md | `data/MEMORY.md` | read-append-write | CRITICAL: lost entries |
| TenantManager | `data/tenants/tenants.json` | read-modify-write | CRITICAL: lost tenant data |
| TaskStore | `data/tasks/{id}.json` | full rewrite per update | HIGH: TOCTOU race |
| sessions.js | `data/sessions/{id}.json` | last-write-wins | MEDIUM: acknowledged |
| SecretVault | `data/.vault.enc` | read-modify-write | MEDIUM: concurrent set() |
| CostTracker | `data/costs/YYYY-MM-DD.jsonl` | appendFileSync | LOW: atomic append |
| AuditLog | `data/audit/YYYY-MM-DD.jsonl` | appendFileSync | LOW: atomic append |

### Scaling Limits
| Component | Current Format | Breaking Point | Fix |
|-----------|---------------|----------------|-----|
| embeddings.json | JSON array, full rewrite | ~650 entries (1.3MB) | SQLite + sqlite-vec |
| tenants.json | Single JSON, all tenants | ~1000 tenants (5MB) | SQLite |
| tasks/ | One JSON per task | ~36K files/year | SQLite |
| sessions/ | One JSON per session | ~1000 sessions | SQLite |
| daily logs | One MD per day, linear scan | 365 files/year × years | SQLite FTS |
| costs/ | JSONL, full scan per query | ~10K entries/day | SQLite |

### OpenClaw's Approach
- LanceDB for vector storage (`openclaw/src/memory/`)
- Proper batch embedding uploads
- SQLite-vec for indexed vector search
- Per-channel session isolation

---

## 5. ERROR HANDLING — SCATTERED, NO HIERARCHY

### Current State (Daemora)
- 573 try/catch blocks across 97 files
- No custom error classes — everything is `Error` or return string
- Silent failures: `catch { return []; }` (`src/tools/memory.js:85-94`)
- Inconsistent logging: some `console.log`, some `console.error`, some silent
- No error codes — can't machine-parse or route errors

### OpenClaw's Approach
- `ToolInputError` for tool validation failures (`openclaw/src/agents/tools/common.ts`)
- Structured error results: `{ status: "error", tool, error: message }`
- Error classes with cause chains
- Descriptive error formatting with stack traces

### Missing Error Classes in Daemora
```
ToolInputError      — malformed params, missing required fields
ConfigError         — invalid config values, missing keys
ChannelError        — channel connection/send failures
BudgetError         — cost limit exceeded
StorageError        — file I/O failures, corruption
SecurityError       — permission denied, secret detected
CompactionError     — context window management failures
```

---

## 6. CHANNEL ARCHITECTURE — 20 IMPLEMENTATIONS, 0 TESTS

### Current State (Daemora)
- BaseChannel: 80 LOC (`src/channels/BaseChannel.js:18-80`)
- 20 channel implementations, each reimplements retry/rate-limit/error handling
- Zero test coverage for any channel
- No shared middleware (retry, rate-limit, circuit breaker)

### OpenClaw's Approach
- Channel abstraction with shared middleware (`openclaw/src/channels/dock.ts`)
- DM policy system: `pairing`/`open`/`closed` (`openclaw/src/channels/dm-policy.ts`)
- Rate limiting, inbound debounce (`openclaw/src/channels/inbound-debounce-policy.ts`)
- Command gating per channel (`openclaw/src/channels/command-gating.ts`)
- Extension channels as separate packages (only install what you need)

### Gap Summary
| Aspect | Daemora | OpenClaw |
|--------|---------|----------|
| Shared retry | None | Built into dock |
| Rate limiting | None | inbound-debounce-policy |
| DM policy | Allowlist only | pairing/open/closed |
| Command gating | None | Per-channel restrictions |
| Testing | 0 tests | Unit + integration tests |
| Packaging | All bundled | Core + extension packages |

---

## 7. PLUGIN/EXTENSION SYSTEM — MINIMAL

### Current State (Daemora)
- HookRunner: 5 events, shell/JS hooks from JSON config (`src/hooks/HookRunner.js`)
- SkillLoader: Static .md files with embedding match (`src/skills/SkillLoader.js`)
- No plugin manifest, no versioning, no marketplace
- No hot-reload of hooks
- No error isolation — hook crash kills the task

### OpenClaw's Approach
- Full plugin system with loader/registry (`openclaw/src/plugins/loader.ts`, `openclaw/src/plugins/types.ts`)
- Plugin manifest with lifecycle hooks (`openclaw/src/plugins/hooks.ts`)
- pnpm workspaces for extension packages
- Plugin SDK exports for third-party development
- Hot-reload support
- Error isolation per plugin

---

## 8. DEPENDENCIES — MONOLITH

### Current State (Daemora)
- All 22 prod deps required even if user only wants Telegram
- `discord.js` (100MB+), `playwright` (100MB+), `botbuilder` (50MB+) always installed
- No optional/peer dependencies
- `package.json:67-93`

### OpenClaw's Approach
- pnpm workspaces: `extensions/discord`, `extensions/matrix`, etc.
- Core package is lean — channels are separate packages
- Users install only what they need

---

## 9. TESTING — 7% COVERAGE

### Current State (Daemora)
- 8 test files across 27.5K LOC source
- Untested: AgentLoop, all 20 channels, 40+ tools, memory, MCP, hooks, skills, compaction
- Tests: `tests/unit/core/{Task,CostTracker}.test.js`, `tests/unit/models/ModelRouter.test.js`, `tests/unit/tenants/{TenantContext,TenantManager}.test.js`, `tests/unit/safety/{SecretScanner,FilesystemGuard}.test.js`, `tests/integration/tenant-isolation.test.js`

### OpenClaw's Approach
- 70% coverage threshold enforced
- Vitest with unit/integration/E2E configs
- Live tests with real API keys
- Docker E2E tests
- Colocated `*.test.ts` files

---

## 10. OBSERVABILITY — CONSOLE.LOG

### Current State (Daemora)
- `console.log` everywhere — no structured logging
- EventBus exists but events go to console
- No log levels (info/warn/error/debug)
- No correlation IDs across request lifecycle
- AuditLog is append-only JSONL (good) but not queryable

### OpenClaw's Approach
- Structured logging infrastructure
- Event-driven observability
- Health monitoring with probes
- Unified log subsystem (macOS `os_log`)

---

## 11. NATIVE TOOL CALLING — ✅ DONE

### What Was Done
- Migrated from custom JSON output schema to Vercel AI SDK native `tool()` + `generateText` + `stopWhen: stepCountIs(N)`
- SDK handles schema conversion per provider (OpenAI, Anthropic, Google/Gemini, Ollama) — no custom logic needed
- Session format uses SDK's provider-agnostic `ModelMessage` types (`tool-call`, `tool-result`, `toolCallId`) — works across all providers
- `compactForSession()` preserves tool call/result structure in sessions (truncates large outputs, keeps context)
- `filterCleanMessages()` only for API display, never for session storage
- `msgText()` utility (`src/utils/msgText.js`) — central text extraction from any SDK message format
- Confirmed: all 4 providers (OpenAI, Anthropic, Google/Gemini, Ollama) work with native tool calling

---

## 12. SUB-AGENT & TEAM IMPROVEMENTS — ✅ DONE

### What Was Done
- Simplified model resolution: `SUB_AGENT_MODEL` → parent model → `DEFAULT_MODEL` (deleted overengineered profile routing)
- Removed `model` param from `spawnAgent` schema — user defines model in `.env`, not per-spawn
- Sub-agent autonomy: "Plan → execute. Never stop after planning. No user. No confirmation."
- Teammate prompt rewritten — terse, with claim→execute→complete loop and comms instructions
- SOUL.md Multi-Agent section rewritten with exact call patterns (spawnAgent, parallelAgents, teamTask)
- Spawn contract: `taskDescription`, `parentContext`, `skills` — applies to spawns and teams
- General-purpose examples (research, writing, product launch — not code-only)
- Skills reduced from 30 to 20 in system prompt
- Sub-agent skill preamble: "If a skill applies → readFile its path, follow it. Skip confirm steps."

### Files Changed
- `src/agents/SubAgentManager.js` — simplified model resolution, `compactForSession` for sessions
- `src/models/ModelRouter.js` — `resolveSubAgentModel()` replaces `resolveModelForProfile`/`getTaskTypeModel`
- `src/agents/systemPrompt.js` — sub-agent context, skill preamble, limit 20
- `src/agents/TeamManager.js` — `_buildTeammatePrompt` rewritten
- `src/tools/schemas.js` — removed `model` from spawnAgent options
- `SOUL.md` — Multi-Agent Orchestration, Memory section added

---

## 13. MEMORY INSTRUCTIONS — ✅ DONE

### What Was Done
- Added `## Memory` section to SOUL.md — when to log, when to save, format rules, categories, security
- Tools: `writeDailyLog`, `writeMemory`, `readMemory`, `searchMemory`
- Categories: preferences, patterns, projects, people, debug

---

## PRIORITY MATRIX

### P0 — ✅ COMPLETE
1. ~~**System prompt diet**~~ — 8K → 2.7K tokens (66% reduction). Done.
2. ~~**Tool schema system**~~ — 54 Zod schemas, named params, validation in AgentLoop. Done.
3. ~~**Native tool calling**~~ — Vercel AI SDK `tool()` + `generateText`, all providers confirmed. Done.
4. ~~**Sub-agent & team maturity**~~ — Model resolution, autonomy, spawn contract, SOUL.md instructions. Done.
5. ~~**Memory instructions**~~ — SOUL.md section for when/how to use memory tools. Done.

### P1 — ✅ COMPLETE
6. ~~**Config validation**~~ — Zod schema (`src/config/schema.js`), fail-closed startup, `channelWith()` DRY helper. Done.
7. ~~**SQLite storage**~~ — `node:sqlite` DatabaseSync, WAL mode, 9 tables, reusable helpers (`queryAll/queryOne/run/transaction`), auto-migration from flat files. Done.

### P2 — Do After (Quality + Scale)
8. **Error class hierarchy** — ToolInputError, ConfigError, etc. New file: `src/errors.js`
9. **Channel middleware** — Shared retry/rate-limit in BaseChannel. File: `src/channels/BaseChannel.js`
10. **Test coverage** — Target 50%. Priority: AgentLoop, tool schemas, memory, channels

### P3 — Future (Ecosystem)
11. **Optional deps** — Move channel SDKs to optional. File: `package.json`
12. **Plugin system** — Manifest, loader, registry. New files: `src/plugins/`
13. **Structured logging** — Replace console.log with pino. All files.
