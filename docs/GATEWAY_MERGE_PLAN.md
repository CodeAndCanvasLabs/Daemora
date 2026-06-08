# Gateway Merge — Execution Plan (#27 + #34)

> Status: ready-to-run spec. Written 2026-06-03 (autonomous).
> This is the OWNER-RESERVED work: it closes the critical tenant-isolation hole
> and needs a deploy + your topology decision, so it is documented (not
> implemented) per the heartbeat rules. Companion to ARCHITECTURE.md §5 and
> DATA_ARCHITECTURE.md. Do this with full attention + deploy validation.

## The one decision (pick first)
- **Option 1 — single-ingress gateway (RECOMMENDED, assumed below):** `apps/api`
  becomes the only public service and reverse-proxies authenticated traffic to
  each user's tenant. One origin → the session cookie is present → the hole closes
  cleanly.
- **Option 2 — shared parent-domain cookie:** keep the separate control plane but
  issue Better Auth cookies on `.daemora.app` so the control plane can read the
  session. Less code, but needs cookie-domain + DNS/cert work and leaves 3 services.

The steps below implement **Option 1**.

## End state
3 Fly apps → **2**: `daemora-gateway` (was apps/api; now also the orchestrator +
reverse proxy) and `daemora-tenants` (per-user machines, unchanged). The control
plane app is deleted.

---

## Phase A — apps/api absorbs the orchestrator + proxy (#27)

**A1. Wire the runtime into apps/api.** `apps/api/src/index.ts` currently talks to
the control plane via `ControlPlaneClient`. Replace that with the real
`TenantManager` (from `src/multitenant/TenantManager.ts`) constructed in-process:
- Add deps: `MASTER_KEK`, `FLY_*` (token, tenant app, region, image), `DAEMORA_RUNTIME`.
- Build `MasterKeyVault.fromEnv()` + `pickRuntime()` (lift from
  `src/cli/commands/controlPlane.ts`) + `new TenantManager({ dataRoot, masterVault, runtime })`.
- Confirm cross-package import works: apps/api and `src/` share the repo (pnpm
  workspace). If TS path resolution complains, add a path alias or a thin
  workspace export; do NOT duplicate the code.

**A2. Provisioning uses the local manager.** In `routes/signup.ts`, swap
`deps.controlPlane.provision(...)` for `deps.manager.create(...) + start(...)`.
Keep the `tenants` Postgres row write (user→slug). Trial expiry → `manager.suspend`.

**A3. Reverse proxy as the catch-all.** Port `proxyHttp` / `proxyUpgrade` from
`src/multitenant/controlPlane.ts` into apps/api. `@hono/node-server`'s `serve()`
returns the `http.Server` — attach the `'upgrade'` listener there for WebSocket
proxying. Mount a Hono catch-all (after `/api/*`, `/signup`, `/billing`, `/agents`,
`/health`) that resolves the tenant (A4) and proxies HTTP; the server's upgrade
handler does the WS path.

**A4. AUTHENTICATED tenant resolution (this is the security fix — T1).** For tenant
traffic, resolve the tenant as **the authenticated user's own tenant** — never a
client-supplied slug:
```
session = auth.api.getSession({ headers })      // present: same origin now
if (!session) → 401 (redirect to login)
tenant = db.select(tenants).where(eq(tenants.userId, session.user.id))
if (!tenant) → 402/404
upstream = manager.getUpstreamUrl(tenant.slug)
proxy(req → upstream, inject X-Daemora-User)
```
Delete the dev-routing hints in prod (the hardened `resolveTenant` becomes
dev/local only). Forging is now impossible — a caller can only reach their own
tenant.

**A5. Signed identity header.** When proxying, inject `X-Daemora-User` (+ tenant)
signed with an `INTERNAL_SIGNING_SECRET` (HMAC, short TTL). The tenant trusts ONLY
this signature — so even on the private network nothing can impersonate the
gateway. Tenants can then keep `AUTH_ENABLED=false` safely (unreachable except via
the gateway). Add verification on the tenant side (a small middleware in
`src/server/index.ts` that checks the signed header when running in tenant mode).

**A6. Tests.** Reuse `apps/api/tests` (pg-mem) + the multitenant control-plane test
patterns: authenticated user → own tenant proxies; foreign/forged → 401/403; WS
upgrade routes; provisioning via local manager. Keep `tsc` + full suite green.

**A7. Deploy collapse.** Merge `fly.controlplane.toml` env into `fly.toml`; the
gateway app gets `MASTER_KEK`, `FLY_*`, `INTERNAL_SIGNING_SECRET`,
`DAEMORA_RUNTIME=fly`, a persistent volume for `DAEMORA_DATA_DIR` (registry +
state — see #25 Fly-volume note). Delete the control-plane app + `Dockerfile.controlplane`
+ `fly.controlplane.toml`. Update `apps/CLOUD_DEPLOY.md`.

---

## Phase B — Secret broker: in-memory delivery (#34)

**B1. Move BYOK keys to central Postgres.** Add a `tenant_api_keys` table to
`apps/api/src/db/schema.ts` (userId/tenantId, keyName, ciphertext, nonce,
key_version) — mirror the existing control-plane SQLite shape; encrypt with
`MasterKeyVault` (KEK + per-user HKDF subkey). Add `key_version` for rotation.

**B2. Stop env injection.** In `TenantManager` env build, **remove** the decrypted
API keys + vault passphrase from the machine env (T6 — env is readable via
`/proc`/dumps).

**B3. Boot-time fetch.** The tenant, at boot, calls the gateway
`GET /internal/secrets` authenticated by a one-time boot token (or the signed
identity), receives its decrypted secrets, holds them **in memory only**, never
writes them to disk. Gateway endpoint validates the boot token, decrypts via
`MasterKeyVault`, returns the bundle. Never log secrets.

**B4. Rotation.** KEK `key_version` + a re-encrypt path. Rotate any key that ever
hit a log.

---

## Verification (must all pass before deploy)
- `npx tsc -p tsconfig.build.json` clean.
- `npx vitest run` green (add: authed-proxy, forged-rejected, secret-broker tests).
- Manual: sign in → reach only your own tenant; a second user can't reach yours;
  forged cookie → 401; tenant boots + fetches secrets in-memory (none in env);
  WS (chat stream) proxies; trial-expiry suspends.
- Deploy to staging first; confirm 2 apps, tenant farm private, no direct tenant
  reachability from the internet.

## Why this is owner-reserved
It only actually closes the hole once **deployed** (the split architecture makes
code-alone useless + risky), it changes the deploy topology, and it touches the
crown-jewels path — so it needs your attention + validation, not an autonomous
overnight run.
