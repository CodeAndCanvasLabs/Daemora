# Engine Refactor — Remove Persona Crews, Keep Generic Sub-Agents

> Status: decision record + execution plan. Written 2026-06-02.
> This is the detailed version of Phase 4 in `ARCHITECTURE.md`. It covers the
> whole sub-agent discussion: why persona crews go, what replaces them, MCP as a
> context firewall, and the exact files to touch.

---

## 1. Why (the decision, recapped)

A "crew" today does **two jobs at once**, and only one of them is worth keeping:

1. **Specialization** — persona + scoped tools + temperature (architect, backend,
   frontend, reviewer, devops, security, planner…). This **duplicates profiles**:
   both `profiles/<id>/` and `crew/<id>/plugin.json` are "soul + tool allowlist +
   skill filter + model override." Same shape, two systems.
2. **Context isolation** — a crew runs in its **own** context and returns only a
   summary (`CrewAgentRunner` does a fresh `streamText` run, returns
   `{text, toolCalls, tokens}`). This does **not** duplicate profiles. It's the
   one thing sub-agents are actually for.

Both competitors confirm the call:
- **OpenClaw** sub-agents = generic isolated runs, parent gets a summary
  (`subagent-registry-completion.ts`). No personas.
- **Hermes** `delegate_task` = generic, with **toolset narrowing**, **MCP
  inheritance**, flat-or-nested depth, parent sees only `{success, summary,
  output_tail}`. No personas.

**Neither uses persona-named sub-agents.** They differentiate by *job shape + tool
scope + isolation*. So:

> **Profiles = the product/persona layer (the worker the customer picks).
> Sub-agents = the internal engine, generic and task-shaped, for context
> isolation + parallelism. Kill the persona crews; keep the runner.**

This is exactly how the Claude Code harness behaves: `Explore` / `Plan` /
`general-purpose` are job-shaped, not personas; MCP tool schemas are loaded lazily
so a big integration surface never blows up the main context.

---

## 1b. CORRECTION (owner clarification, 2026-06-02)

Integration crews are **not** persona duplicates — they are the **per-integration
sub-agents**, the exact MCP-style delegation we want (`use_crew("twitter", …)`
instead of carrying every `twitter_*` schema in the main context). They **stay.**
So this is *not* "delete all 29." Reconciled scope:

- **KEEP — per-service sub-agents:** the 14 integration crews + `browser-pilot`
  (the sub-agent for the Playwright MCP). These are the delegation surface; each
  external service has one sub-agent, same shape as MCP.
- **REPLACE — pure persona crews that duplicate profiles:** architect, backend,
  frontend, reviewer, devops, security, planner, analyst, researcher, ssh-remote,
  meeting-attendant, video-editor, notifications → collapse into generic
  **explore** + **mcp_runner** sub-agents.
- **FIX the bloat (this is the real Stream B win):** hide the eager integration
  *tool schemas* from the main agent (exactly how `playwright` is already hidden
  via `HIDE_FROM_MAIN`), so integrations are reached **only** via their sub-agent.
  With this, a separate `use_integration` tool is unnecessary — the integration
  crew *is* the delegation. Stream B becomes "hide integration tools from main +
  keep integration crews," not "add a new tool."
- **Update profile `soul.md` + `profiles/_shared/runtime.md`** crew-usage
  instructions to match (which crews exist, when to delegate).

The sections below are superseded where they say "delete the integration crews" —
follow this correction.

## 2. What we keep, replace, delete

### Keep (the engine)
- `src/crew/CrewAgentRunner.ts` — the isolation engine. Fresh run, scoped tools,
  summary-only return, persistent `crew:<id>` session, blocks nested `use_crew`,
  always-on `skill_view`/`memory_*`. **This is the asset.** Rename optional
  (`SubAgentRunner`) but not required for the refactor.
- `parallel_crew` capability — keep the fan-out path (rename to `parallel_agent`).
- MCP staying **lazy** (`use_mcp`, schemas client-side) — already correct, no
  change. The new mcp-runner sub-agent wraps *multi-step* MCP work for result
  isolation, not schema isolation.

### Replace (persona crews → generic sub-agents)
Two built-in generic sub-agents, defined once (not 10 personas):
- **`explore`** — read-only research/codebase/file sweep. Tools: read/search/grep/
  list + `skill_view` + `memory_*`. Returns the conclusion, not the file dump.
- **`mcp_runner`** — runs a multi-step MCP / heavy-tool job and returns just the
  answer. Tools: `use_mcp` + whatever the task names. The **context firewall** that
  lets a worker carry many integrations without choking.

Both are just `CrewAgentRunner` invocations with a generic manifest + a
task-shaped prompt. No persona souls.

### Delete (the duplication)
- `crew/architect`, `crew/backend`, `crew/frontend`, `crew/reviewer`,
  `crew/devops`, `crew/security`, `crew/planner`, `crew/github`,
  `crew/browser-pilot`, `crew/ssh-remote`, … — every persona crew under `crew/`.
- `crews.json` in **all** profiles (now dead config).
- The crew **summary block** and **crew filter** in the system prompt.

---

## 3. Blast radius — exact files

| File | Change |
|---|---|
| `crew/<persona>/plugin.json` (all persona dirs) | **Delete** the persona crews. Replace with `crew/explore/` and `crew/mcp-runner/` generic manifests (or register them in code). |
| `src/crew/CrewAgentRunner.ts` | **Keep.** Verify the blocked-tools list still bars nested delegation; ensure generic agents get the read/search/`use_mcp` tools they need. |
| `src/crew/CrewLoader.ts` / `CrewRegistry.ts` | Keep loader/registry, but they now load 2 generic agents instead of ~10 personas. Drop `listForProfile`/profile-filter usage if profiles no longer scope sub-agents (they shouldn't — generic agents are always available). |
| `src/crew/types.ts` | Trim manifest fields that only made sense for personas (e.g. `profile.systemPrompt` persona soul) if unused. |
| `src/tools/core/useCrew.ts` | Keep `use_crew`/`parallel_crew`/`stop_crew`/`list_crews` (optionally rename `*_agent`). The delegation contract stays: `task`, `context`, `constraints`, `successCriteria`. |
| `src/core/AgentLoop.ts` | **Remove** `profileCrewFilter()` (~L272–283) and the **crew summary** injected into the system prompt (~L485–490). Keep `installCrews()` wiring (~L217–228) but it now installs the 2 generic agents. |
| `src/cli/commands/start.ts` | Phase-2 crew boot (~L279–312): load 2 generic agents; keep `DAEMORA_DISABLED_CREWS` honored (so an operator can turn a sub-agent off) but it's now a 2-item universe. |
| `profiles/*/crews.json` (×10) | **Delete.** Profiles no longer scope sub-agents. (Keep `tools.json`, `skills.json`, `soul.md`, `manifest.json`.) |
| `src/core/TaskRunner.ts`, channels, any callers | Grep for `use_crew`, `crewId`, `listForProfile`, `crews.json`, `parallel_crew` and fix references. |

> Before deleting, `grep -rn "crew" src/ profiles/ apps/` to catch stragglers
> (TaskRunner, channel handlers, tests, system-prompt snapshots).

---

## 4. System-prompt effect

**Before:** every turn carried a "Available Crews" block listing ~10 personas +
descriptions (overhead, no isolation payoff) and a per-profile crew filter.

**After:** the prompt lists 2 generic sub-agents (`explore`, `mcp_runner`) with a
one-line "delegate isolated work here" note. Smaller prompt, clearer intent,
context firewall preserved.

---

## 5. Execution steps (order)

1. **Add the 2 generic sub-agents** (`explore`, `mcp_runner`) and confirm they run
   via `CrewAgentRunner` with the right scoped tools. Keep `parallel`.
2. **Repoint callers** to the generic agents; make sure delegation still returns
   summary-only.
3. **Strip the crew summary + `profileCrewFilter`** from `AgentLoop`; update
   `start.ts` Phase-2 boot.
4. **Delete persona crew dirs** and all `profiles/*/crews.json`.
5. **Grep sweep** for dangling `crew` references (TaskRunner, channels, tests,
   prompt snapshots) and fix.
6. **Update tests** — any crew/system-prompt snapshot tests; add a test that a
   delegated `explore` job returns a summary and does not leak the sub-agent
   transcript into the parent context.

## 6. Verify

- A worker asked to "find where X is implemented" delegates to `explore` and gets
  a conclusion; the parent context grows by the summary, **not** the files read.
- A worker asked to do a multi-step MCP task delegates to `mcp_runner`; the heavy
  tool results stay in the sub-agent.
- `parallel` still fans out (two delegations run concurrently).
- System prompt no longer lists persona crews; `tsc -p tsconfig.build.json` clean;
  Vitest green.

---

## 7. What this is NOT

- Not removing sub-agents — we **keep** the runner; it's the engine.
- Not removing profiles — profiles are the product layer and stay.
- Not touching MCP's lazy loading — that's already right.
- Not a persona zoo — exactly two generic, task-shaped agents.
