# Daemora — Target Architecture & Hardening Plan

> Status: proposal / decision record. Written 2026-06-02.
> Scope: how Daemora runs (local **and** cloud) as one clean system, the security
> gaps that block a multi-tenant launch, and the path from today's 3-service mess
> to a production-ready 2-target design. Also locks the agent-engine model
> (profiles vs sub-agents) and the self-learning loop.

---

> **Progress:** see `docs/STATUS.md`. Done: engine refactor, integrations-lazy,
> self-learning, multi-agent (profile-per-session, memory provenance, plan-tiered
> roster). Security §5 HARDENED; full closure = the gateway merge (#27, now in
> progress, Option 1 single-ingress). Auth model §5.5 holds.

## 0. TL;DR

- **One binary, two deploy targets.** Daemora-core is a single server that runs
  *identically* on a laptop (`daemora start`) and as a per-user cloud machine.
  The public edge ("gateway") is the only other thing we deploy. The "tenant
  farm" is not a third service — it's daemora-core packaged as a Fly image.
- **3 Fly apps → 2.** Merge `apps/api` (auth/billing) and the control plane
  (orchestrator + reverse proxy) into one **gateway**. Keep the tenant-machine
  image as the second Fly app (Fly Machines *requires* a registry image; that's
  the only reason it exists separately).
- **One critical security blocker:** the control plane resolves the active tenant
  from an **unverified JWT claim** (`controlPlane.ts` `decodeTenantClaim`). This
  must be replaced with session-derived tenant resolution before any launch.
- **Move the tenant registry off SQLite into Postgres (Neon).** Today it lives in
  the control plane's local SQLite and is wiped on redeploy. Postgres is already
  there for users/billing; the tenant registry belongs next to it.
- **Self-learning is real and ~70% live.** Per-turn background review + persistent
  memory + skills + compaction all work. Three strong pieces — extraction,
  memory decay, smart-recall re-ranking — are built but unwired. Activating them
  (with a curator + rollback) puts us genuinely ahead of Hermes.
- **Skills already load enabled-only.** The "all skills always loaded" worry is
  unfounded; the gap is a *per-user* enable/disable UX, which our per-tenant
  process model makes easy.

---

## 1. The product shape (what we're actually building)

Daemora is **infrastructure for persistent, specialized AI workers**, not a chat
app. Two user-facing concepts:

- **Profiles = the worker the customer picks** (Coding Engineer, Sales Hunter,
  Research Analyst…). A profile is a real config change: soul/persona, tool
  allowlist, skill visibility, model, autonomy. This is the surface neither
  OpenClaw nor Hermes has cleanly — it's ours to own.
- **Sub-agents = the internal engine**, invisible to the customer. They exist for
  *context isolation*, not personas. See §6.

The same daemora-core process is the worker. Locally it's your single worker.
In the cloud, each user gets their **own** daemora-core machine. Mobile/desktop
apps (later) are just authenticated clients to the gateway, which proxies to your
worker — "chat from anywhere" without the self-host pain that sinks OpenClaw.

---

## 2. Current state (honest snapshot)

### 2.1 The three Fly apps today

| App | Role | Runs | Port | Storage |
|-----|------|------|------|---------|
| `deamora-specialized-saas` | Public API | Hono: Better Auth, `/signup`, `/billing`, admin | 8090 | Postgres (Neon): users, subscriptions, tenants-meta, audit |
| `daemora-control-plane` | Orchestrator + reverse proxy | `control-plane start`; spawns/stops tenant machines, proxies HTTP+WS | 8080 | **SQLite** `tenants.db` (registry, encrypted per-tenant API keys) — *wiped on redeploy* |
| `daemora-tenants` | Tenant image + machines | per-user daemora-core, one Fly Machine + Volume each | 8081 | Fly Volume `/data` (per tenant) |

- API → control plane over private 6PN (`*.flycast`) with a shared
  `CONTROL_PLANE_ADMIN_TOKEN`.
- Control plane → tenant machine over 6PN
  (`<slug>.vm.daemora-tenants.internal:8081`) or, locally,
  `127.0.0.1:<port>` via `LocalChildProcessRuntime`.
- Runtime is env-toggled: `DAEMORA_RUNTIME=fly` → `FlyMachinesRuntime`,
  else local child processes. **Local and cloud already run the same core.**

### 2.2 What's genuinely solid

- `FilesystemGuard` sandbox (`src/safety/FilesystemGuard.ts`): symlink/realpath
  escape blocking, blocks `.ssh/.aws/.kube`, blocks daemora's own DB, shell
  arg scanning. Strong — for the **local** runtime.
- `MasterKeyVault` (`src/multitenant/MasterKeyVault.ts`): AES-256-GCM with
  per-tenant HKDF subkeys, fails loudly if `MASTER_KEK` missing.
- Better Auth: email verification required, 30-day sessions, httpOnly/sameSite
  cookies, magic-link 15-min expiry, trusted origins.
- API hardening (`apps/api/src/lib/security.ts`): CSP, HSTS (prod), exact-origin
  CORS, 5/10min auth rate limit, audit logging that never throws.

---

## 3. Self-learning — what's real, what's dormant

Daemora's learning system mirrors Hermes' 4-layer loop and is **architecturally
richer in places** (smart-recall blend, decay audit log). Status:

| Capability | File | State |
|---|---|---|
| Per-turn background review (forked agent, narrow toolset, writes skills+memory) | `src/learning/BackgroundReviewer.ts` (fires every ~10 turns, ≤8 steps, fire-and-forget) | ✅ **live** |
| Persistent declarative memory (`USER.md`/`MEMORY.md`, frozen snapshot into prompt) | `src/memory/DeclarativeMemoryStore.ts` | ✅ **live** |
| Episodic memory (SQLite FTS5, tagged, BM25) | `src/memory/MemoryStore.ts` | ✅ **live** |
| Context compaction (head/tail protect, summarize middle, child session) | `src/core/Compaction.ts` | ✅ **live** |
| Skill CRUD at runtime (atomic write, security scan, live registry reload) | `src/tools/core/skillManage.ts` | ✅ **live** |
| **Insight extraction** from task output (regex rules → memory) | `src/learning/ExtractionPipeline.ts` | ⚠️ **built, never called** (`start.ts` `void extraction`) |
| **Memory decay/pruning** (recency/recall rules + audit log) | `src/learning/MemoryDecay.ts` | ⚠️ **built, no cron** |
| **Smart-recall re-ranking** (0.5·BM25 + 0.3·recency + 0.2·frequency) | `src/learning/SmartRecall.ts` | ⚠️ **built, `memory_recall` still uses raw search** |
| Curator (consolidate/merge skills) + snapshot rollback | — | ❌ **missing** |

**Decision:** The claim "better than Hermes" is true *in design* but currently
overstated *in runtime*. Wiring the three dormant pieces and adding a curator
with snapshot/rollback (Hermes' key safety net — without it, auto-learning rots)
gets us to genuine parity-plus. Two twists Hermes can't copy:

1. **Team-shared learning** — workers in one workspace share a learned-skill +
   memory pool. One worker learns your API; the whole team's workers know it.
2. **Visible learning** — a "what your worker learned this week" feed. Hermes
   learns silently; we make it a feature you can see (attractive + sticky).

---

## 4. Skills & tools loading — the "enabled-only" question

**Already correct.** Skills with `enabled: false` in frontmatter are dropped at
**load time** (`SkillLoader.ts` ~L294) and never enter the registry. On top of
that, at render time `SkillRegistry.visible()` filters by:
- profile `skills.json` include/exclude,
- `requires_tools` (tool must be available),
- `requires_integrations` (integration must be connected),
- platform, and `fallback_for_tools`.

The system prompt only ever carries **name + description** per visible skill
(progressive disclosure); full bodies load on demand via `skill_view`. So context
does **not** balloon with skill count.

**The real gap is per-user control.** Settings (`DAEMORA_PROFILE`,
`DAEMORA_DISABLED_CREWS`, integration accounts) live in one shared SQLite and are
global to a process. In our model that's **fine** — each tenant *is* its own
process with its own data dir — so per-user enablement is naturally per-user.
What's missing is the **UX**: a tenant-local "skills" settings table + a UI toggle
that flips `enabled` / a `DAEMORA_DISABLED_SKILLS` list in the tenant's own store.
That's a small, self-contained add, not an architecture change.

Same pattern for tools: gated by connected integrations + profile allowlist
(which can hide even `alwaysOn` tools). MCP is already **lazy** — schemas stay
client-side, only a textual server/tool list is in the prompt; this is *better*
than eager tool loading and we keep it.

---

## 5. Security audit — blockers before any multi-tenant launch

Prioritized. The first one is a launch blocker.

> **STATUS 2026-06-03 — partially mitigated.** The forgeable unverified-JWT
> routing path is **removed**; `X-Tenant-Slug`/`?slug=`/cookie are now **dev-only**
> (`controlPlane.ts` `resolveTenant`); production honors the Host subdomain only.
> **Still open:** per-tenant daemoras run with `AUTH_ENABLED=false` (TenantManager
> never sets it) and the control plane does not yet prove the *caller* owns the
> subdomain. Full closure = the control plane authenticates the Better Auth
> session and maps user→tenant (design below), or the gateway merge (#27). Until
> then the tenant farm MUST stay behind the network boundary.
>
> **Closure design (authenticated routing) — BLOCKED on a topology decision
> (2026-06-03).** The clean design (control plane calls an `apps/api`
> `/internal/my-tenant` endpoint with the forwarded session cookie, caches ~30s,
> routes only to the authenticated slug) hits the **cross-domain cookie problem**:
> the Better Auth session cookie lives on the `apps/api` origin
> (`api.daemora.com`), but tenants are served on different origins
> (`alice.daemora.app`), so the control plane never receives the cookie. There is
> currently **no link** between the apps/api session and tenant access
> (`AUTH_ENABLED=false` on tenants). Two ways to make it real — owner's call:
>   1. **Single-ingress gateway (#27 merge):** `apps/api` becomes the ingress and
>      reverse-proxies to the user's tenant — one origin, cookie present, identity
>      passed through to the tenant. Cleanest; the intended end state. **Until it
>      lands, the hole can't be fully closed; tenant farm MUST stay private.**
>   2. **Shared parent-domain cookie:** issue Better Auth cookies on `.daemora.app`
>      and host tenants under that parent so the cookie is shared across
>      subdomains; control plane then validates it. Needs cookie-domain config +
>      DNS/cert work.
>
> Note: flipping `AUTH_ENABLED=true` on tenants does NOT work standalone — remote
> tenants don't inject the loopback file-token, so users get locked out unless the
> gateway passes identity through (again #27).

### 🔴 CRITICAL — Unverified tenant claim (tenant isolation bypass)
`src/multitenant/controlPlane.ts` resolves the active tenant from a JWT claim
decoded **without signature verification** (`decodeTenantClaim`, marked
"Phase 8 verifies"). An attacker can forge `{ tenant: "victim" }` and the proxy
routes them straight into the victim's machine — there is no auth between proxy
and tenant backend.
**Fix:** delete JWT-claim routing. Resolve tenant **only** from the authenticated
Better Auth session: gateway has the session → looks up `user → tenant` in
Postgres → injects a trusted, signed internal header to the proxy. The api+control-
plane merge (§7) makes this natural because the session lives in the same process.
Also: explicitly disable `?slug=` query routing outside dev.

### 🟠 HIGH — Per-tenant secrets injected as env vars
`TenantManager.ts` decrypts API keys and injects them as machine env. Readable via
`/proc/<pid>/environ`, crash dumps, logs. Acceptable for MVP *because each tenant
is its own VM* (blast radius = that one user), but document the hardening path:
have the tenant **fetch its secrets at boot** from the gateway over an
authenticated channel, or pass via sealed file, instead of env.

### 🟠 HIGH — Admin token is a god token
`CONTROL_PLANE_ADMIN_TOKEN` grants control over *all* tenants with no per-admin
RBAC or per-tenant ownership check. Keep it strictly server-to-server (gateway
only), put all human admin actions behind `users.isAdmin` + audit, and log every
tenant mutation (who/what/when).

### 🟠 HIGH — Tenant-to-tenant 6PN reachability
All machines in the tenant app can reach each other over 6PN. Normal traffic only
flows via the proxy, but a compromised tenant could pivot to siblings. Mitigate
with Fly private-network egress limits where possible; treat each tenant VM as the
isolation boundary and keep the sandbox strict.

### 🟡 MEDIUM
- **`MASTER_KEK` has no rotation or version tag.** Add a `key_version` column to
  encrypted secrets so we can rotate without a big-bang re-encrypt.
- **Tenant should hard-code `/data`** and ignore `DAEMORA_FS_ALLOW` from env
  (defense in depth if the orchestrator is ever compromised).
- **No rate limit on admin API**; add one.
- **Audit lives in the same DB as secrets.** Fine for now; note a separate sink as
  a future item.

---

## 5.5 Authentication model (decision)

Three trust boundaries → three mechanisms. Do **not** use one hammer, and do
**not** use JWT for user auth.

1. **Local mode (`daemora start` on a laptop): keep the loopback token.**
   We need a secret *even locally* because the server binds a port and the agent
   can run shell / read files / touch the vault. Any website your browser visits
   could POST to `http://localhost:8081` (DNS-rebinding / CSRF) and command your
   agent. Defense = **bind 127.0.0.1 only + validate Origin/Host + a loopback
   token auto-injected into the page** (`<meta name="api-token">`, already in
   place). This is exactly what Jupyter / VS Code tunnels do. It's frictionless
   (the user never types it) and it's the mature choice — don't remove it.

2. **Cloud user auth (browser → gateway): Better Auth opaque session + cookie.**
   Opaque, server-stored, instantly revocable session token in an httpOnly +
   Secure + SameSite cookie. **Not JWT.** This is what we already have — keep it.

3. **Gateway → core (server-to-server, cloud): signed internal header.**
   The gateway authenticates the session, looks up which tenant the user owns,
   then injects a **short-lived HMAC-signed internal header** (`X-Daemora-Tenant`
   / `X-Daemora-User` + signature, shared secret). The core trusts *only* that
   signature. This **replaces the unverified-JWT routing** that is the CRITICAL
   hole in §5.

4. **Mobile / desktop (later): the same opaque session token as a Bearer header**
   (cookies are awkward on native), or per-device revocable tokens. Still
   server-stored, still not JWT.

**Why not JWT for user auth:** can't revoke without extra infra, leaks in
logs/URLs, painful rotation, and it directly invites the "decode-without-verify"
bug class we already have. Opaque + server-side is the mature default.

**Streaming note:** EventSource can't set headers. In cloud, same-origin cookies
are sent automatically, so SSE just works; locally, use `?token=`. The Stream-D
streaming hook handles both.

---

## 6. Agent engine — profiles vs sub-agents (locked)

Both competitors validate the model: OpenClaw sub-agents and Hermes `delegate_task`
are **generic, isolated, toolset-narrowed** runs that return only a summary —
*neither uses persona sub-agents*. So:

- **Keep profiles as the product/persona layer.**
- **Replace the persona "crews"** (`crew/architect`, `backend`, `reviewer`, …,
  which duplicate profiles) **with a small set of generic, task-shaped sub-agents**
  reusing the existing `CrewAgentRunner` engine:
  - an **explore/research** isolator (read a lot, return the conclusion),
  - an **MCP/heavy-tool runner** (run a multi-step tool job, return the answer) —
    the context firewall that lets a worker carry many integrations.
- Strip the now-dead `crews.json` from each profile; remove the crew summary +
  filter from `AgentLoop`/`start.ts`. Keep `parallel` capability on the generic
  runner so we don't lose fan-out.

This makes the engine behave the way the harness that wrote this doc behaves:
differentiation by *job shape + isolation*, not by personality.

---

## 7. Target architecture

### 7.1 Two deploy targets + one binary

```
                         Internet
                            │
         ┌──────────────────▼───────────────────┐
         │            daemora-gateway            │   ← Fly app #1 (public)
         │  (merge of apps/api + control plane)  │
         │  • Better Auth, /signup, /billing     │
         │  • Admin API (isAdmin + audit)        │
         │  • Tenant registry  → Postgres (Neon) │
         │  • Reverse proxy (HTTP+WS)            │
         │      tenant = f(authenticated session)│  ← fixes the CRITICAL gap
         │  • Orchestrator (Local | Fly runtime) │
         │  • MasterKeyVault (KEK)               │
         └───────┬───────────────────┬───────────┘
                 │ 6PN / localhost    │ Fly Machines API
        ┌────────▼─────────┐ ┌────────▼──────────────────────────┐
        │ local child proc │ │       daemora-core machines        │  ← Fly app #2
        │ (self-host/dev)  │ │  one per user · Volume /data       │     (image only)
        └──────────────────┘ │  sandbox · enabled-skills · learn  │
                             └────────────────────────────────────┘

        daemora-core is ONE codebase:
          • `daemora start`            → local single worker (laptop / self-host)
          • Fly Machine (this image)   → per-user cloud worker
          • `daemora gateway`          → run the edge locally for multi-user self-host
```

- **Fly app #2 is not a third service.** It's daemora-core's *deployment image*.
  Fly Machines need an OCI image in the registry; that's the only reason it's a
  separate app. Logically there are **two** things: the **gateway** and the
  **core**.
- **Local == cloud.** The runtime abstraction already gives this. Locally you run
  core alone, or run the gateway with `LocalChildProcessRuntime` for multi-user.
  No special "cloud mode" code beyond `DAEMORA_RUNTIME`.
- **Mobile/desktop later** are clients of the gateway. The gateway already proxies
  HTTP+WS to the user's core, so a phone/desktop app is "authenticate → talk to
  gateway." No new backend.

### 7.2 State, after the move

| Data | Where | Notes |
|---|---|---|
| Users, sessions, subscriptions, audit | Postgres (Neon) | unchanged |
| **Tenant registry + encrypted per-tenant keys** | **Postgres (Neon)** | **moved off control-plane SQLite — survives redeploy** |
| `MASTER_KEK` | Fly secret (gateway) | add `key_version` |
| Per-tenant data (db, vault, memory, skills, wiki, files) | Fly Volume `/data` | unchanged; persists across machine restarts |

---

## 8. Migration plan (phased, safe order)

Each phase ships independently; tests are the safety net (Vitest runs on `tsx`,
so keep `tsc -p tsconfig.build.json` green too — that's what catches the type
breaks Vitest misses).

**Phase 1 — Persistence fix (unblocks the "wiped registry" pain)**
- Port `TenantStore` from SQLite to Postgres (reuse the Neon connection).
- Encrypted keys + events tables move with it. Add `key_version` column.
- *Verify:* create tenant, redeploy gateway, tenant still resolves.

**Phase 2 — Security: session-derived tenant routing (CRITICAL fix)**
- Remove `decodeTenantClaim` JWT routing and `?slug=` in prod.
- Gateway resolves tenant from Better Auth session → `user→tenant` lookup →
  signed internal header to the proxy.
- Tenant hard-codes `/data`, ignores env `DAEMORA_FS_ALLOW`.
- *Verify:* forged token / foreign slug → 403; legitimate session → own tenant.

**Phase 3 — Service merge (3 → 2)**
- Fold the control-plane HTTP server + reverse proxy into the gateway Hono app
  (admin under `/admin/*` behind `isAdmin` + audit + rate limit).
- One Dockerfile, one deploy. Delete `fly.controlplane.toml`,
  `Dockerfile.controlplane`. Keep the tenant image (`Dockerfile.tenant`,
  `fly.tenants.toml`).
- *Verify:* full signup → provision → proxy round-trip on one app.

**Phase 4 — Engine: crews → generic sub-agents**
- Delete persona crews; add generic explore + mcp-runner sub-agents on the
  existing runner. Strip `crews.json` + crew summary/filter from `AgentLoop`/
  `start.ts`. Keep parallel fan-out.
- *Verify:* a worker delegates a search and an MCP job; main context stays lean.

**Phase 5 — Activate self-learning + curator**
- Wire `ExtractionPipeline.schedule()` into task completion.
- Schedule `MemoryDecay.runDecay()` on the cron scheduler (weekly).
- Switch `memory_recall` to `SmartRecall.recall()`.
- Add a curator pass (consolidate skills) **with tar.gz snapshot + rollback**.
- Add per-user skill enable/disable (tenant-local table + UI toggle).
- *Verify:* a correction in one session changes behavior next session; decay log
  populates; a bad consolidation can be rolled back.

**Phase 6 — Polish for launch**
- Per-user read rate limits (stop email-enumeration via `/signup/status`).
- Admin audit on every tenant mutation.
- KEK rotation runbook.

---

## 9. What we deliberately do NOT build (yet)

- **No Firecracker / rootless-container / seccomp tier.** Each tenant VM is the
  isolation boundary for MVP; the sandbox + per-VM model is enough. Revisit when
  an enterprise deal demands it.
- **No bespoke vector DB.** BM25 + smart-recall blend is enough; add embeddings
  only if recall quality demands it.
- **No third service.** Two targets. Resist re-splitting the gateway.
- **No persona sub-agent zoo.** Generic, task-shaped only.

---

## 10. Open decisions for the owner

1. **Phase order** — do Phase 2 (security) *before* Phase 3 (merge), or fold them
   together? They're cleaner together (the merge is what makes session-routing
   trivial), but that's a bigger single PR.
2. **Team-shared learning** — workspace-scoped shared memory/skills is the moat,
   but adds a sharing/permission model. MVP single-user-per-tenant first, then add
   the workspace layer?
3. **Mobile/desktop timing** — gateway-as-client-API should be designed now (so we
   don't bake in assumptions), even if the apps come later.
