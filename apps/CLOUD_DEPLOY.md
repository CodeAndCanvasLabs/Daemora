# Daemora — Cloud Deployment Guide

> **ARCHITECTURE UPDATE (2026-06-03) — single-ingress gateway.** The control plane
> is now merged into `apps/api`: it authenticates every request and reverse-proxies
> to the user's own tenant in-process. So it's **2 Fly apps**, not 3 — the separate
> `daemora-control-plane` app is no longer needed (delete it at deploy time). The
> tables below describe the legacy 3-app layout; see "Run locally" first.

## Run locally (single-ingress gateway)

Run the whole thing on your laptop before any Fly deploy — local mode spawns each
tenant as a child process (no Fly needed):

1. **Build the native dep:** `npm rebuild better-sqlite3` (must succeed — the
   orchestrator + tenants use it).
2. **Env** (e.g. in `apps/api/.env.local`):
   ```
   DATABASE_URL=postgres://…              # Neon or local Postgres
   MASTER_KEK=<base64 32 bytes>           # encrypts BYOK secrets
   SESSION_COOKIE_SECRET=<base64 32+>
   JWT_SIGNING_KEY=<base64 32+>
   INTERNAL_SIGNING_SECRET=<base64 20+>   # signs the gateway→tenant identity
   DAEMORA_RUNTIME=local                  # spawn tenants as child processes
   DAEMORA_DATA_DIR=./data                # tenant data root
   PUBLIC_API_URL=http://localhost:8090
   PUBLIC_APP_URL=http://localhost:5173
   ```
   (Generate secrets with `openssl rand -base64 32`. Never commit them.)
3. **Apply DB migrations** under `apps/api/drizzle/` (incl. `agents`,
   `tenant_api_keys`).
4. **Boot the gateway:** `npx tsx apps/api/src/index.ts`
   → `[gateway] listening on :8090 (runtime=local)`.
5. **Flow:** sign up + verify email via Better Auth (`/api/auth/*`) → `POST
   /signup/start-trial` provisions a **local tenant child process** → every
   non-gateway request (`/`, `/api/chat`, …) is proxied to **your** tenant only
   (gateway routes by your authenticated session — no client-supplied slug). The
   tenant trusts the gateway's signed `X-Daemora-User` header.

**Security note:** tenant isolation is enforced at the gateway (a caller can only
reach their own tenant). Tenants run with `AUTH_ENABLED=false` safely *because* they
sit behind the authenticating gateway on a private boundary — never expose tenant
ports directly.

---

Three Fly apps make up the full cloud product:

| Fly app | What | Public? | Deploys via |
|---|---|---|---|
| `deamora-specialized-saas` | apps/api — auth, signup, billing, status | Yes (`*.fly.dev` + `daemora.com`) | `fly-deploy` → target `apps-api` |
| `daemora-control-plane` | multi-tenant orchestrator | **Private** (`.flycast` only) | `fly-deploy` → target `controlplane` |
| `daemora-tenants` | farm — one Fly Machine per user | Public (`<slug>.daemora.app`) | `fly-deploy` → target `tenant-image` + machines spawned dynamically |

## How requests flow

```
   User browser                     │
   ──────────────                   │
   daemora.com (UI)                 │  1. Signs in via UI
        │                           │
        ▼                           │
   apps/api (deamora-specialized…)  │  2. POST /signup/start-trial
        │                           │
        ▼  internal flycast HTTP    │
   daemora-control-plane            │  3. Create + start machine
        │                           │
        ▼  Fly Machines API         │
   daemora-tenants (Fly app)        │  4. New Machine boots
        ├─ machine: alice           │     w/ Dockerfile.tenant image
        ├─ machine: bob             │
        └─ machine: charlie         │
   ──────────────                   │
   User browser                     │
        │                           │
   alice.daemora.app (or            │  5. User clicks "Open daemora"
   localhost:8080/?slug=alice)      │     hits control plane proxy
        │                           │
        ▼                           │
   daemora-control-plane            │  6. Proxies to flycast URL of
        │                           │     the alice machine
        ▼                           │
   alice's Fly Machine              │  7. Serves daemora UI + API
```

## One-time setup

### 1. Create the three Fly apps

```bash
flyctl apps create deamora-specialized-saas      # already exists
flyctl apps create daemora-control-plane
flyctl apps create daemora-tenants
```

### 2. Build + push the tenant image

GitHub Actions: **Actions tab → `fly-deploy` → Run workflow → target: `tenant-image`**.

Or CLI:
```bash
flyctl deploy --app daemora-tenants \
  --dockerfile Dockerfile.tenant \
  --image-label tenant --build-only --push --remote-only
```

This builds `Dockerfile.tenant` and pushes it as `registry.fly.io/daemora-tenants:tenant`.

### 3. Set control-plane secrets

```bash
flyctl secrets set --app daemora-control-plane \
  FLY_API_TOKEN="$(flyctl auth token)" \
  FLY_TENANT_APP_NAME=daemora-tenants \
  FLY_REGION=iad \
  FLY_TENANT_IMAGE=registry.fly.io/daemora-tenants:tenant \
  MASTER_KEK="<same MASTER_KEK as apps/api>" \
  CONTROL_PLANE_ADMIN_TOKEN="<same as apps/api>"
```

The `MASTER_KEK` MUST match what apps/api has — both services share encrypted tenant API key material.

### 4. Deploy the control plane

GitHub Actions: **Actions tab → `fly-deploy` → Run workflow → target: `controlplane`**.

Or CLI:
```bash
flyctl deploy --config fly.controlplane.toml \
  --dockerfile Dockerfile.controlplane --remote-only
```

### 5. Wire apps/api → control plane

apps/api's `fly.toml` already has:
```toml
CONTROL_PLANE_INTERNAL_URL = "http://daemora-control-plane.flycast:8080"
```

Once the control-plane app is up, `/signup/start-trial` will reach it over the private 6PN network. No DNS / no public URL.

### 6. Verify

```bash
# apps/api still alive
curl https://deamora-specialized-saas.fly.dev/health

# Signup → control plane → real Fly Machine
# (use the UI or a curl flow that authenticates first)
```

## How to roll out a new tenant image

1. Bump anything in `src/` that should affect tenants.
2. Run **fly-deploy** workflow with target `tenant-image` (rebuilds + pushes).
3. Optionally bump the image tag in `FLY_TENANT_IMAGE` if you want versioned rollouts.
4. Restart the control plane: **fly-deploy** with target `controlplane` (or `flyctl machines restart --app daemora-control-plane`).
5. New tenants spawn with the new image. **Existing tenants keep their old image** until their machine is destroyed + recreated (do this per-tenant via `/admin/tenants/:slug/stop` + `/admin/tenants/:slug/start` when ready).

## Cost shape

| Component | Cost driver |
|---|---|
| apps/api | 1 always-warm machine (`min_machines_running=1`), shared-1x 512MB ≈ **\$3/mo** |
| daemora-control-plane | 1 always-warm machine ≈ **\$3/mo** |
| daemora-tenants Fly Volumes | 3 GB per tenant ≈ **\$0.45/mo each** |
| daemora-tenants machines | Pay-per-CPU-second when active; sleep otherwise. Typical idle user ≈ **\$0.30/mo** |
| Outbound bandwidth | Fly's $0.02/GB after 100GB free |

Rough total for 100 active users: \$6 (always-warm) + 100 × \$0.75 (volume + active time) ≈ **\$80/mo**. Scales linearly per user.

## What to do if a deploy fails

| Symptom | Fix |
|---|---|
| `403 high risk` from Fly | Unlock at https://fly.io/high-risk-unlock |
| Stale image (deploy says success but `/health` shows old behavior) | `flyctl machines restart --app <app>` |
| Control plane can't reach tenants | Check `FLY_API_TOKEN` is set + has org access. Check `FLY_TENANT_APP_NAME` matches actual app name. |
| Tenant machine starts but `/health` 502 | Check that tenant's machine logs: `flyctl logs --app daemora-tenants --machine <id>` |
| Cookie / auth issues | Confirm `MASTER_KEK` is identical on apps/api and control plane |

## Roadmap

- **Done:** apps/api, control plane, FlyMachinesRuntime, deployment artefacts
- **Next:** custom subdomain routing (`<slug>.daemora.app`) via Fly certs + DNS
- **Later:** snapshot-to-R2 archive flow when a tenant goes inactive 30 days
- **Later:** per-tenant resource caps (CPU/mem) tuned by plan
