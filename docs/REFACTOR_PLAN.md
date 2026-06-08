# Daemora — Master Refactor Plan

> **Progress:** see `docs/STATUS.md` for the live done/in-progress board.
> Done: Stream A (teams removed), Stream B (integrations lazy), engine refactor
> (crews→generic), self-learning + multi-agent (profile-per-session, memory
> provenance, plan-tiered roster). In progress: gateway merge (single ingress).
> Remaining: API cleanup (Stream D, #28) + UI rewrite (Stream C, #29) — LAST.

> Status: plan / decision record. Written 2026-06-02.
> Companion to `ARCHITECTURE.md` (cloud/security/services/self-learning) and
> `ENGINE_REFACTOR.md` (crews → generic sub-agents). This doc covers the
> remaining refactors the owner asked for: **remove teams**, **run integrations
> like MCP (lazy, enabled-only)**, **rebuild the UI**, and **fix the UI↔API
> calling architecture**.

The four docs together describe the whole-Daemora cleanup. Suggested global
order is at the end (§6).

---

## Work Stream A — Remove the Teams system

**What it is:** a DAG orchestration layer (`teams` = graph of `workers`, each
worker optionally referencing a crew/profile, run by `TeamRunner`). The agent
`team` tool is **already disabled** and **the UI never calls `/api/teams`**. So
this is a clean delete, not a behavior change.

**Delete:**
- `src/teams/TeamStore.ts`, `src/teams/TeamRunner.ts`, `src/teams/templates.ts`
- `src/tools/core/teamTool.ts`
- `src/server/routes/teams.ts`
- team endpoints in `src/server/routes/compat.ts` (~L687–707:
  `/api/teams`, `/api/teams/templates`, `/api/teams/:id`, `.../disband`)

**Unwire (remove references):**
- `src/server/index.ts` — `import type { TeamStore }` (L30), `mountTeamRoutes`
  import (L57), `teamStore` in `ServerDeps` (L95), `mountTeamRoutes(app, deps)` (L310)
- `src/cli/commands/start.ts` — `TeamStore` import (L73), `new TeamStore(...)` (L164),
  `teamStore` passed to `createApp` (L470)
- `src/tools/core/index.ts` — `TeamStore` import (L19), commented `makeTeamTool` (L62),
  `teams?` in `CoreToolDeps` (L87), the disabled block (L208–212)
- `src/safety/PermissionGuard.ts` — drop `"team"` from the `standard` tier (L81)
  and the comment (L7)

**Tables:** `teams` / `team_workers` are created on `TeamStore` init; once the
store is gone they simply stop being created. No migration needed; existing rows
are harmless (drop them in a cleanup migration if desired).

**Verify:** `tsc -p tsconfig.build.json` clean; grep `team` in `src/` returns only
unrelated matches; app boots; no `/api/teams` mounts.

**Risk:** Low. Self-contained, already-disabled, no UI dependency.

---

## Work Stream B — Integrations behave like MCP (lazy + enabled-only)

### The problem (measured)
Integration tools are **registered eagerly** (`registerIntegrationTools()` in
`start.ts`) and every enabled integration's **full Zod schemas** are sent to the
model each turn (`ToolRegistry.available()` → `selectFor()` →
`AgentLoop` L304–328 → `tools:` param). MCP is the opposite: schemas are
discovered at connect time but **never sent**; a single `use_mcp(server, tool,
args)` delegation tool is exposed, and the prompt only carries a **text list**
(`AgentLoop` L493–532).

> 5 integrations (twitter 10 + youtube 8 + gmail 6 + facebook 7 + instagram 5)
> = **~36 schemas every turn**. The MCP-style equivalent = **1 schema** + a text list.

### The change: one `use_integration` delegation tool
Mirror `useMCP.ts` exactly.

- **Add** `src/tools/core/useIntegration.ts` — `alwaysOn`, core-sourced. Input:
  `{ integration, action, args, task? }`. Validates the integration is enabled
  (`IntegrationManager.getEnabled()`), maps `action` → the existing provider tool
  fn, calls it (token fetched from `IntegrationManager`, OAuth flow unchanged),
  returns `{ integration, action, result }`.
- **Add an action manifest** per provider (static, built from the existing
  `make*Tools()` definitions in `src/integrations/<provider>/tools.ts`) so the
  delegation tool knows the action list + arg shapes. This reuses the schemas you
  already have — they just move out of the model's tool list and into a
  server-side registry the delegation tool validates against.
- **Remove** the eager `registerIntegrationTools(...)` call from `start.ts`.
  Integration tools no longer enter `ToolRegistry` as individual model tools.
- **System prompt:** add a "## Connected Integrations" block (enabled only),
  formatted like MCP: `- twitter: post, search, timeline, like, …`. Add the
  `use_integration(...)` instruction. (`AgentLoop` buildSystemPrompt, next to the
  MCP block ~L493–532.)
- **Gating stays the same source of truth:** `getEnabled()` (account present in
  `IntegrationStore`). Disabled/unconnected integrations don't appear in the text
  list and the tool rejects them — same UX as MCP's "enable at /mcp".

### Notes / decisions
- **OAuth differs from MCP** (integrations hold refreshable tokens) — fine: the
  delegation tool calls `IntegrationManager.getAccessToken()` which already
  auto-refreshes. No change to the OAuth/credential layer.
- **GitHub/Notion** are already MCP-backed via `MCPIntegrationBridge`; leave them
  as MCP.
- This is **Option A** (delegation tool), chosen over Option B (lazy Zod schema
  loading) because Zod schemas are static and lazy-loading them is a much bigger,
  riskier change for the same context win.

**Verify:** with 5 integrations enabled, the `tools:` param sent to the model
contains `use_integration` (not 36 tools); the prompt lists the integrations as
text; `twitter` post via `use_integration("twitter","post",{...})` works and
refreshes tokens; a disabled integration is absent + rejected.

**Risk:** Medium. Behavior-preserving for the *capability*, but it changes how the
model invokes integrations — update any skills/prompts that reference direct tool
names (e.g. `twitter_post`) to the delegation form.

---

## Work Stream C — UI rewrite

### Current state (honest)
React 18 + Vite 6 + React Router 7 + Tailwind 4 + Radix/shadcn. ~18.5k LOC, 23
pages. The Radix `ui/` primitive library and the `api.ts`/`auth.ts` helpers are
**good and worth keeping**. The problems:

- **Mega-files:** `Settings.tsx` 1,779 · `StarField.tsx` 1,699 · `Chat.tsx` 1,096
  · `Cron.tsx` 1,047 · `Setup.tsx` 1,014 · `Integrations.tsx` 889 ·
  `Watchers.tsx` 820 · `MCP.tsx` 745 · `Files.tsx` 651 · `Crew.tsx` 556.
- **No state/query library** — manual `useState`/`useEffect` + ad-hoc polling on
  every page; no caching or dedup.
- **No shared hooks** — loading/error state reimplemented ~17×.
- **No error boundaries** — one render error takes down the app.
- **No tests.**
- **Duplicated patterns** — task list (Logs vs Tasks), delete-confirm (×5+),
  collapsible section, OAuth dialog.

### Approach: keep the foundation, rebuild the surface
**Keep:** `ui/src/app/components/ui/` (Radix primitives), the cohesive theme,
`Layout.tsx`, and the *patterns* in `api.ts`/`auth.ts` (token injection, vault
recovery) — folded into the new API layer (Stream D).

**Rebuild around the product model** (`ARCHITECTURE.md` §1): the UI should read as
"a roster of persistent workers," not a pile of admin pages. Concretely:

1. **Design system first** — `tailwind.config.ts` + design tokens (kill the
   scattered hardcoded `#00d9ff`/`#4ECDC4`/… and 11 inline styles).
2. **Shared building blocks** — `components/patterns/`:
   `ConfirmDialog`, `TaskTable`, `FormSection`, `OAuthButton`, `StatusBadge`,
   `EmptyState`/`ErrorState`/`LoadingState`, `PageHeader`.
3. **Shared hooks** — `hooks/`: `useApi`, `usePoll`, `useConfirm`, and the
   streaming hooks from Stream D.
4. **Split the mega-pages** into feature folders with a `useX` data hook +
   presentational subcomponents. Priority order by pain:
   `Settings` → `Chat` → `Cron` → `Setup` → `Integrations` → `Watchers`.
5. **`StarField.tsx` (1,699 LOC)** — replace the hand-rolled animation with a
   small canvas component or drop it; it's almost a fifth of the UI by lines.
6. **Error boundaries** at the route level + a fallback UI.
7. **Tests** — Vitest + Testing Library on the new hooks and patterns before
   porting each page.

### UI features that change because of other streams
- **Crew page** (`Crew.tsx`) → becomes a small "Sub-agents" view (explore /
  mcp-runner) per `ENGINE_REFACTOR.md`, or folds into Settings. Persona-crew
  management UI goes away.
- **Teams** — nothing to do (no UI today).
- **Integrations / MCP pages** — both become "connected services" lists that map
  to the lazy/text-listed model from Stream B; the integration page stays for
  OAuth connect/disconnect.
- **New: per-user Skills enable/disable toggle** (`ARCHITECTURE.md` §4) — a real
  settings surface backed by a tenant-local table.

### Cloud-awareness
In the SaaS model the UI is served by, and talks **through**, the gateway proxy to
the user's own daemora-core; auth is the Better Auth **session**, not the local
file-token. The new API layer (Stream D) must take a configurable base + session
auth so the same UI works locally (file-token) and in cloud (session). Design this
in now even though mobile/desktop come later — they'll be clients of the same API
layer.

**Risk:** High effort, low architectural risk (the backend API is stable). Do it
incrementally page-by-page behind the new API layer; don't big-bang.

---

## Work Stream D — UI↔API calling architecture

### The problem (measured)
- **121 endpoints** across 27 route files; UI hits them via **90 hardcoded
  `/api/*` strings** in 23 files. One endpoint rename = a 90-site manual hunt.
- **0 shared types** — every page redefines `Message`, `Crew`, `Goal`, … inline;
  drift is invisible until runtime.
- **23 different error patterns** (toast / console / inline).
- **No caching/dedup** — manual fetch + poll on every navigation.
- **3 hand-rolled SSE implementations** (Chat, TaskDetail) with duplicated parse +
  reconnect logic.
- Good part already in place: **all calls go through `apiFetch()`** (one token
  injection + vault-recovery seam) — build on that.

### Target: one typed client + query layer + streaming hook

1. **Shared types** (`packages/shared/` or `ui/src/api/types.ts`) — request/
   response types for every route, imported by **both** server and UI. The server
   route handlers are the source of truth; export their types and consume them in
   the client. (Optionally generate from a schema later; start by hand-sharing.)
2. **Typed client** (`ui/src/api/client.ts`) — one object, one method per
   endpoint, URLs defined **once**:
   ```ts
   api.crew.list() / api.goals.create(g) / api.chat.send(input, sid)
   api.chat.streamTask(taskId) // returns the stream hook input
   ```
   Wraps the existing `apiFetch` (token injection, vault recovery, configurable
   base for local vs gateway).
3. **Query layer** — TanStack Query for caching, dedup, stale-while-revalidate,
   and mutations with invalidation. Kills the ad-hoc polling and the 17× manual
   loading/error state.
4. **Streaming hook** (`ui/src/api/streaming.ts`) — one `useEventSource` /
   `useTaskStream` that parses events, manages reconnect/backoff, and cleans up on
   unmount. Replaces the 3 copies.
5. **One error path** — client throws typed errors; a query error boundary +
   toast handles display uniformly; `401 → re-auth` lives in the client.
6. **Auth** — client takes the file-token (local) or relies on the session cookie
   (cloud) via one config switch; no per-page auth logic.

### Sequencing
Build D **before/with** C — the rewritten pages should be born on the typed client
+ query hooks, not ported twice. Migrate page-by-page: stand up the client +
TanStack + streaming hook, then convert pages as you rebuild them in Stream C.

**Verify:** an endpoint rename is a one-line client change; a page shows cached
data instantly then revalidates; the chat stream reconnects on drop; no `/api/`
string literals remain in pages (lint rule to enforce).

**Risk:** Medium. Mechanical but broad; the typed client is the safety rail.

---

## 5. Cross-cutting cleanups surfaced during exploration

- **`compat.ts`** is a legacy shim with duplicate endpoints (teams, crew, costs,
  cron). As the typed client lands, retire compat routes and collapse to one
  canonical route per resource.
- **`/api/sessions/:id/stream`** is noted as "currently unused" — confirm and
  remove if dead.
- **Profiles/settings are global, not per-user** — fine in the per-tenant process
  model, but the new Skills/Integrations toggles must write to the tenant's own
  store (ties to `ARCHITECTURE.md` §4).

---

## 6. Global ordering (all four docs)

Dependencies first, context wins early, UI last (so it's built on the final API).

1. **A — Remove teams.** Trivial, removes noise before touching servers.
2. **B — Integrations → lazy `use_integration`.** Big context win; backend-only.
3. **Engine refactor** (`ENGINE_REFACTOR.md`): crews → generic sub-agents.
4. **Cloud Phases 1–3** (`ARCHITECTURE.md`): registry → Postgres, session-based
   tenant routing (the **critical** security fix), merge 3 services → 2.
5. **D — Typed API client + query + streaming layer.** The spine for the UI.
6. **C — UI rewrite**, page-by-page on top of D.
7. **Self-learning activation + curator** (`ARCHITECTURE.md` Phase 5) and launch
   polish (Phase 6) in parallel with C.

Each step ships independently and keeps `tsc -p tsconfig.build.json` + Vitest
green. Nothing here is a big-bang; the typed client and per-stream verification are
the safety rails.

---

## 7. What we are NOT doing

- Not keeping teams "just in case" — it's dead, delete it.
- Not lazy-loading integration Zod schemas (Option B) — the delegation tool
  (Option A) gets the same context win for far less risk.
- Not rewriting the Radix `ui/` primitives — they're good.
- Not a UI big-bang — incremental on the new API layer.
- Not introducing a heavy state framework (Redux) — TanStack Query + local state
  is enough.
