# Daemora — Build Status

> Canonical at-a-glance tracker. Last updated 2026-06-03.
> Detail lives in the linked docs; this is the "what's done" board.

## ✅ Done + verified (tsc clean, ~219 tests, 218 pass — the 1 fail is a pre-existing weather skill-matcher, unrelated)

| # | Task | Notes |
|---|------|-------|
| 22 | **Remove teams system** | deleted `src/teams/`, tool, routes, refs |
| 24 | **Crews → generic sub-agents** | 2 generics (`explore`, `mcp-runner`); kept integration crews + browser-pilot; profile instructions updated (`ENGINE_REFACTOR.md`) |
| 23 | **Integrations lazy** | integration tool schemas hidden from main agent → reached via their sub-agent |
| 30 | **Self-learning** | ExtractionPipeline + MemoryDecay wired; `SkillCurator` (snapshot/rollback/stale) — `src/learning/SkillCurator.ts` |
| 31 | **Multi-agent: profile-per-session** | concurrent agents per user; AgentLoop per-turn profileId; sessions carry `profile_id`; compaction inherits it |
| 33 | **Cross-agent context sharing** | MemoryStore `agent_id` provenance + "mine + shared" recall (threat T3) |
| 32 | **Plan-tiered agent limits + roster** | central `agents` table (apps/api); free=1/pro=5/enterprise=25; `GET/POST/DELETE /agents` |
| — | **Supporting** | `vitest.config.ts` (stop scanning vendored `agents/`); full design docs in `docs/` |

## ✅ Gateway merge + security + secret broker (2026-06-03 — verified, runs locally)

| # | Task | State |
|---|------|-------|
| 26 | **Tenant-isolation security** | **CLOSED in code** by #27 — routing driven solely by the authenticated session; tenants trust only the gateway's signed `X-Daemora-User`. |
| 27 | **Gateway merge (single ingress)** | **DONE** — apps/api authenticates + reverse-proxies to the user's OWN tenant (in-process orchestrator, HTTP+WS, signed identity, provisioning swapped). 3→2 Fly apps. Run locally per `CLOUD_DEPLOY.md`. |
| 34 | **Secret broker** | **DONE (infra)** — central `tenant_api_keys`, `getDecryptedSecrets`, guarded `/internal/secrets`, in-memory boot client. ONE owner flip left: delete env-injection after local validation (see `DATA_ARCHITECTURE.md`). |

## ⬜ Deferred — coupled to the UI rewrite

| # | Task | Notes |
|---|------|-------|
| 28 | **API cleanup + typed client** | Audit done + CORRECTED (`API_AUDIT.md` — grep-based removal is unreliable: substring/template-string/response-shape). Removal coupled to #29 UI rewrite — not done blind (would break the untested UI). |

## ⬜ Owner-led / later

| # | Task | Notes |
|---|------|-------|
| 25 | Registry persistence | owner applies a Fly volume (deploy config) |
| 35 | Artifact + live preview (Lovable/Bolt) | per-tenant machine = the runtime advantage |
| 28 | API cleanup | ~67 dead/duplicate endpoints (`API_AUDIT.md`) — owner wants LAST |
| 29 | UI rewrite | owner wants LAST |

## Owner actions outstanding
- Rotate secrets that were echoed earlier in chat (Neon pw, Resend, JWT/SESSION/MASTER keys, Fly token, sessions).
- Apply the control-plane Fly volume (#25).
- Deploy + validate the gateway merge after local verification.

## Doc map
`ARCHITECTURE.md` · `SECURITY_AND_MULTIAGENT.md` · `DATA_ARCHITECTURE.md` ·
`GATEWAY_MERGE_PLAN.md` · `ENGINE_REFACTOR.md` · `REFACTOR_PLAN.md` · `API_AUDIT.md`
