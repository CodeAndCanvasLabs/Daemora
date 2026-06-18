# Daemora — Data Architecture (where each thing lives)

> Status: decision record. Written 2026-06-03.
> Trust is the business. Leak BYOK keys once and the company is over. This is the
> data-placement policy that makes that hard. Companion to SECURITY_AND_MULTIAGENT.md.

## Guiding principle: machines are CATTLE, not pets

A tenant's Fly machine is **disposable** — destroyable and rebuildable from central
state at any moment with **zero loss of anything critical**. This single rule wins
on both axes the owner cares about:
- **Trust:** a dead or compromised machine never loses or leaks the crown jewels —
  secrets and account config live centrally; the machine only holds a working copy
  of bulk data (recoverable from backup).
- **Cost:** machines can autostop / be rebuilt freely; no precious state pins them.

So: **secrets + account-defining config + identity → central Postgres (encrypted,
durable, queryable). Bulk operational data → machine SQLite (fast), backed up to
object storage. The machine receives secrets in-memory at runtime — never persists
them.**

## Placement table

| Data | Store | Rationale |
|---|---|---|
| Users, sessions, subscriptions, billing | **Central Postgres** (Neon) | identity/billing source of truth (already) |
| Tenant/account metadata (plan, status, Fly refs) | **Central Postgres** | survives machine loss; queryable for ops/billing |
| **Agent roster + count, profiles enabled** | **Central Postgres** | account config; drives **plan enforcement** |
| **BYOK API keys / secrets** | **Central Postgres, encrypted** (KEK + per-user HKDF subkey) | crown jewels — durable, central, hardened |
| **Goals, setup config, plan caps** | **Central Postgres** | durable account config; machine reads at boot |
| Chat / conversation history | **Machine SQLite** (volume) | bulk, high-churn, latency-sensitive; backed up |
| Memory (`MEMORY.md`, FTS5), wiki | **Machine** (volume) | read every turn → latency; backed up to object storage |
| Files / projects / outputs | **Machine** (volume) | bulk artifacts; backed up to object storage |
| Audit log | **Central Postgres** (already) | security events, central + tamper-evident |
| Memory/file **backups** | **Object storage (R2/S3)** | machine/volume loss is never fatal |

## Why NOT everything in Postgres
Chats + memory are read/written **every turn** and grow large; centralizing them
adds latency, load, and cost for no security gain (a chat message isn't a secret).
Bulk conversational/memory data stays machine-local **with backups**; only the
**sensitive + account-defining** data is central.

## Crown-jewels handling (non-negotiable — threat T6)
1. API keys encrypted at rest with `MASTER_KEK` + **per-user HKDF subkey**
   (already in `MasterKeyVault`), stored in **central Postgres**.
2. Delivered to the tenant **at boot over the authenticated gateway channel**,
   held **in memory only**. **Stop injecting secrets as env vars** (current
   `TenantManager` does — env is readable via `/proc` / crash dumps).
3. **Never logged.** KEK **versioned + rotatable** (add `key_version`). Rotate any
   key that ever appeared in a log.

## Multi-agent + plan tiers (the account model)
- **Agent roster is central** (Postgres `agents` table: per user → agentId,
  profileId, name, status). The tenant instance reads its roster at boot.
- **Plan → max agents:** free = 1, pro = several, enterprise = many. Enforced at
  the account layer (gateway / apps/api) on "create agent"; the instance trusts
  the roster it's handed.
- **Context sharing between a user's agents:** their agents share one instance →
  one memory store, so shared memory is near-free. Tag every memory entry with
  **provenance** (`agentId`) so recall can be "mine + shared", and a poisoned
  agent can't silently command a peer (memory is DATA, never instructions — T3).
  Cross-USER sharing is a separate trust boundary — explicit opt-in only.

## Secret broker — status (2026-06-03)

Built + tested (the path that delivers BYOK secrets to a tenant IN-MEMORY instead
of via env):
- central `tenant_api_keys` table (apps/api, encrypted, `key_version`);
- `TenantManager.getDecryptedSecrets(slug)` — single decrypt source;
- gateway `GET /internal/secrets` — signed-identity guarded (only the gateway's
  `X-Daemora-User` token gets in), returns the tenant's secrets;
- tenant-side `fetchTenantSecrets()` boot client (holds them in memory, fails soft).

**OWNER'S FINAL FLIP (local-validated):** env injection of decrypted secrets in
`TenantManager.start()` is STILL the working default (with a T6-removal TODO). Once
you validate the broker locally (tenant boots, fetches `/internal/secrets`, runs
with no secrets in its env), set the tenant to fetch at boot
(`DAEMORA_SECRET_BROKER_URL` + identity token) and DELETE the env-injection block.
Not done autonomously because it can only be confirmed by a real gateway+tenant run.

## How this folds into the build
The **gateway merge (#27)** is the keystone: it owns Postgres and becomes the
boot-time **secret broker** + roster provider. Sequence:
1. Gateway merge → single authenticating ingress.
2. Move secrets + account config to Postgres; deliver secrets in-memory at boot
   (drop env injection).
3. Multi-agent: profile-per-session + `agentId`, central roster, plan limits.
4. Context sharing: memory provenance + shared/scoped recall.
5. KEK versioning + object-storage backups for durability.
