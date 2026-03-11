# Daemora vs OpenClaw — Full Gap Audit

Where Daemora lacks, what OpenClaw does better, and what to fix. File-indexed.

---

## 1. TOOL SYSTEM — CRITICAL GAP

### Current State (Daemora)
- Tools dispatched as string arrays: `tools[name](...params)` (`src/core/AgentLoop.js:313`)
- Output schema: `params: z.array(z.string())` (`src/services/models/outputSchema.js:7`)
- Tool name: `z.string()` — no enum validation (`src/services/models/outputSchema.js:5`)
- Each tool manually parses its own params with inconsistent patterns
- Tool docs in system prompt as prose (~2,953 tokens)
- No per-tool schema — model guesses param order from natural language

### Evidence of Fragility
```
readFile(filePath, offsetStr, limitStr)     → manual parseInt    (src/tools/readFile.js:11-13)
executeCommand(cmd, optionsJson)            → manual JSON.parse  (src/tools/executeCommand.js:24)
webSearch(query, optionsJson)               → silent parse fail  (src/tools/webSearch.js:18-22)
editFile(filePath, oldString, newString)     → manual type check  (src/tools/editFile.js:5-10)
browserAction(action, param1, param2)       → 500-line switch    (src/tools/browserAutomation.js:271-738)
spawnAgent(taskDesc, optionsJson)           → JSON.parse or {}   (src/tools/spawnAgent.js:66)
```

### OpenClaw's Approach
- TypeBox schemas per tool (`openclaw/src/agents/tools/browser-tool.schema.ts`)
- Schemas passed directly to LLM via `parameters` field on tool definition
- Runtime validation via helpers: `readStringParam()`, `readNumberParam()` (`openclaw/src/agents/tools/common.ts`)
- Custom `ToolInputError` class for validation failures
- Provider-specific schema normalization (`openclaw/src/agents/pi-tools.schema.ts`)
  - Strips `anyOf`/`oneOf` for Gemini
  - Removes `minLength`/`maxLength` for xAI
  - Forces `type: "object"` for OpenAI
- Tool result format: `{ content: [{ type: "text", text }], details }` — structured, not raw strings

### Gap Summary
| Aspect | Daemora | OpenClaw |
|--------|---------|----------|
| Param format | `string[]` positional | Named object with schema |
| Validation | Manual per-tool | TypeBox schema + runtime helpers |
| Tool name check | `if (tools[name])` at runtime | Schema enum, compile-time typed |
| Error class | Generic Error/string | `ToolInputError` |
| Provider compat | Single format | Normalized per-provider |
| Result format | Raw string/object | Structured `AgentToolResult` |
| Docs location | System prompt (~3K tokens) | Schema metadata (0 prompt tokens) |

---

## 2. SYSTEM PROMPT — TOKEN BLOAT

### Current Token Budget
| Section | Tokens | % |
|---------|--------|---|
| SOUL.md | 3,609 | 45% |
| renderToolDocs() | 2,953 | 37% |
| renderResponseFormat() | 726 | 9% |
| renderSubagentContext() | 319 | 4% |
| renderSkills() | ~300 | 4% |
| renderMCPTools() | ~247 | 3% |
| renderToolUsageRules() | 161 | 2% |
| renderRuntime() | 58 | <1% |
| **Total fixed** | **~8,054** | — |

### OpenClaw's System Prompt
- `buildAgentSystemPrompt()` — 30+ params, conditionally includes sections (`openclaw/src/agents/system-prompt.ts:189-689`)
- Tool docs: one-line summaries only (`- read: Read file contents`)
- 3 modes: `full`, `minimal`, `none`
- Estimated: ~2-3K tokens for typical session

### Duplication in Daemora
| Content | Location 1 | Location 2 | Wasted Tokens |
|---------|-----------|-----------|---------------|
| Auto-spawn triggers | SOUL.md:119-131 | systemPrompt.js:328-339 | ~300 |
| Planning rules | SOUL.md:48-73 | systemPrompt.js:189 (ref) | ~200 |
| Memory guidance | SOUL.md:152-158 | systemPrompt.js:283-310 | ~250 |
| Orchestration | SOUL.md:111-149 | systemPrompt.js:322-366 | ~575 |

### Sections Daemora Sends That OpenClaw Doesn't
- Full JSON response schema in prompt (OpenClaw uses Zod output schema)
- Full tool param signatures with option JSON examples
- Coding guidelines (agent already knows how to code)
- Research guidelines (agent already knows how to research)
- Communication guidelines (agent already knows how to send email)
- 500-line browserAction docs (should be in tool schema metadata)

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

## PRIORITY MATRIX

### P0 — Do Now (Blocks Everything Else)
1. **System prompt diet** — 8K → 4K tokens. Dedup SOUL.md/systemPrompt.js, remove verbose tool docs, conditional sections. Files: `SOUL.md`, `src/agents/systemPrompt.js`
2. **Tool schema system** — Zod schemas per tool, named params instead of string arrays, remove tool docs from prompt. Files: `src/services/models/outputSchema.js`, `src/tools/*.js`, `src/core/AgentLoop.js`

### P1 — Do Next (Data Safety + Reliability)
3. **Config validation** — Zod schema for config, startup validation. File: `src/config/default.js`
4. **SQLite storage** — Replace flat JSON for memory/tasks/sessions/tenants. Files: `src/tools/memory.js`, `src/storage/TaskStore.js`, `src/services/sessions.js`, `src/tenants/TenantManager.js`

### P2 — Do After (Quality + Scale)
5. **Error class hierarchy** — ToolInputError, ConfigError, etc. New file: `src/errors.js`
6. **Channel middleware** — Shared retry/rate-limit in BaseChannel. File: `src/channels/BaseChannel.js`
7. **Test coverage** — Target 50%. Priority: AgentLoop, tool schemas, memory, channels

### P3 — Future (Ecosystem)
8. **Optional deps** — Move channel SDKs to optional. File: `package.json`
9. **Plugin system** — Manifest, loader, registry. New files: `src/plugins/`
10. **Structured logging** — Replace console.log with pino. All files.
