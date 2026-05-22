# Daemora SaaS — UI Integration Guide

How the web UI talks to `apps/api` and the daemora control plane. Everything
in this doc is built around one principle: **nothing static, everything driven
by env vars + a single API client**. If a URL, port, or path is hard-coded in
a component, it's a bug.

---

## 1. Local boot sequence

Four processes + Postgres. All ports are env-overridable.

| # | Service                       | Default port | Env var                              |
|---|-------------------------------|--------------|--------------------------------------|
| 1 | Postgres                      | 5432         | (in `DATABASE_URL`)                  |
| 2 | `apps/api` (Hono)             | 8090         | `PORT`                               |
| 3 | Control plane                 | 8080         | `--port` flag on the CLI             |
| 4 | UI dev server (Vite)          | 5173         | `vite.config.ts` → `server.port`     |
| — | Per-tenant daemora            | 8101–8999    | Auto-assigned by control plane       |

### `.env.local` for `apps/api`

```bash
DATABASE_URL=postgresql://daemora:dev@localhost:5432/daemora_dev
JWT_SIGNING_KEY=$(openssl rand -base64 32)
SESSION_COOKIE_SECRET=$(openssl rand -base64 32)
MASTER_KEK=$(openssl rand -base64 32)
CONTROL_PLANE_INTERNAL_URL=http://localhost:8080
CONTROL_PLANE_ADMIN_TOKEN=$(openssl rand -hex 24)
PUBLIC_APP_URL=http://localhost:5173      # the UI origin — used for cookie scope + CORS
PORT=8090

# Email — leave RESEND_API_KEY unset in dev; mails are captured in-memory
CONTRA_PAYMENT_LINK_LITE=https://contra.com/payment-link/...lite
CONTRA_PAYMENT_LINK_PRO=https://contra.com/payment-link/aWzV57XT-daemora-research
```

### `.env.local` for the UI

```bash
# All UI env vars MUST be prefixed VITE_ so Vite exposes them to the browser.
# Never put secrets here — these end up in the browser bundle.
VITE_API_BASE_URL=http://localhost:8090
VITE_TENANT_PROXY_URL=http://localhost:8080
VITE_TENANT_HOST_SUFFIX=.daemora.app          # used only in prod
VITE_DAEMORA_BRAND=daemora
VITE_DEFAULT_PLAN=pro
VITE_POLL_INTERVAL_MS=3000
VITE_TRIAL_LENGTH_DAYS=7
VITE_ENABLE_MAGIC_LINK=true
```

### Boot order

```bash
# 1. Postgres
docker run -d --name dmpg -p 5432:5432 \
  -e POSTGRES_USER=daemora -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=daemora_dev postgres:16

# 2. Migrate SaaS DB
DATABASE_URL=postgresql://daemora:dev@localhost:5432/daemora_dev \
  npx drizzle-kit push --config=apps/api/drizzle.config.ts

# 3. Control plane
node dist/cli/index.js control-plane start --port 8080

# 4. apps/api  (loads .env.local automatically via dotenv)
node apps/api/dist/index.js

# 5. UI
cd apps/web && npm run dev    # http://localhost:5173
```

---

## 2. API surface — what the UI calls

Base URL = `VITE_API_BASE_URL` (NEVER hard-code). Auth = `daemora.session_token`
cookie set by Better Auth — UI must `fetch` with `credentials: "include"`.

| Method | Path                                       | Auth        | Purpose                                                                                  |
|--------|--------------------------------------------|-------------|------------------------------------------------------------------------------------------|
| GET    | `/health`                                  | —           | Ping                                                                                     |
| POST   | `/auth/sign-up/email`                      | —           | `{ email, password, name? }` → sends verify mail                                         |
| POST   | `/auth/sign-in/email`                      | —           | `{ email, password }` → sets session cookie                                              |
| POST   | `/auth/sign-in/magic-link`                 | —           | `{ email, callbackURL }`                                                                 |
| GET    | `/auth/verify-email?token=…`               | —           | Better Auth handles; redirects                                                           |
| POST   | `/auth/sign-out`                           | cookie      | Clears session                                                                           |
| GET    | `/auth/get-session`                        | cookie      | `{ user, session }` or null                                                              |
| POST   | `/signup/start-trial`                      | cookie      | Provisions tenant + creates 7-day trial. Idempotent.                                     |
| GET    | `/signup/status`                           | cookie      | `{ user, trial: { state, daysLeft, subscription? }, tenant }`                            |
| POST   | `/signup/checkout`                         | cookie      | `{ plan: "lite" \| "pro" }` → `{ url, provider }`                                        |
| POST   | `/billing/claim`                           | cookie      | `{ transactionId, plan }` → `{ claim, state }`                                           |
| GET    | `/billing/claims/mine`                     | cookie      | `{ claims: ClaimRow[] }`                                                                 |
| POST   | `/billing/admin/claim/:id/confirm`         | bearer      | Operator only                                                                            |
| POST   | `/billing/admin/claim/:id/reject`          | bearer      | Operator only                                                                            |

### Response shapes — keep these in a shared types file

```ts
// apps/web/src/lib/api-types.ts
export type TrialState = "none" | "trialing" | "active" | "expired" | "canceled";

export interface TrialStatus {
  state: TrialState;
  daysLeft: number;
  subscription?: { plan: "trial" | "lite" | "pro"; status: string; trialEndsAt?: string };
}

export interface Tenant {
  id: string;
  slug: string;
  status: "provisioning" | "running" | "sleeping" | "suspended" | "archived";
}

export interface SignupStatusResponse {
  user: { id: string; email: string; emailVerified: boolean; name?: string };
  trial: TrialStatus;
  tenant: Tenant | null;
}

export interface ClaimRow {
  id: string;
  transactionId: string;
  plan: "lite" | "pro";
  status: "pending" | "confirmed" | "rejected";
  rejectionReason?: string;
  createdAt: string;
}
```

---

## 3. UI configuration — the rules

These are non-negotiable. If a code review finds any of these violated, fix
before merging.

### Configuration

1. **Every URL, port, path, timeout, feature flag, and brand string comes from
   `import.meta.env.VITE_*`.** No literals in components.
2. **Load + validate env at app boot with zod**, mirroring `apps/api/src/lib/env.ts`.
   Fail loud on missing required vars. Cache the parsed object and import it
   everywhere — never read `import.meta.env` directly outside that module.
3. **No secrets in the UI bundle.** Anything `VITE_*` ships to the browser.
   API keys, admin tokens, signing keys live only in `apps/api`.
4. **One `api()` client wrapper** in `lib/api.ts`. All fetches go through it.
   It owns: base URL, `credentials: "include"`, default headers, JSON parsing,
   typed errors, retry logic. Components never call `fetch` directly.
5. **One `paths` object** in `lib/api-paths.ts` listing every endpoint as a
   typed const. Refactor-friendly; grep-friendly.
6. **Tenant URL is built**, not hard-coded: `buildTenantUrl(slug)` reads
   `VITE_TENANT_PROXY_URL` (dev) or `https://${slug}${VITE_TENANT_HOST_SUFFIX}` (prod).

### Auth + sessions

7. **Use the Better Auth React client.** Don't read or write cookies from
   components. Don't store tokens in localStorage.
8. **Session refresh is automatic** via the Better Auth client. Show a
   loading skeleton while it boots, not a flash of unauthed UI.
9. **Route guards live in one place** (`<RequireAuth>` + `<RequireVerified>`),
   not sprinkled in pages.

### Data fetching

10. **TanStack Query for everything async.** No `useEffect(() => fetch…)`
    patterns. Cache keys are `["status"]`, `["claims"]`, etc.
11. **`/signup/status` polls with `refetchInterval`** = `VITE_POLL_INTERVAL_MS`
    while `tenant.status === "provisioning"`, stops once running. Never
    poll once it stabilises.
12. **Optimistic updates** for `POST /billing/claim` — show the pending row
    immediately, reconcile on success.
13. **Every query has loading + error + empty states.** No bare spinners with
    no failure handling.

### UX + a11y

14. **No native browser dialogs.** Use the project's `AlertDialog` component
    (see memory: this rule is repo-wide).
15. **Form validation** with zod resolvers — same schema in UI and API where
    possible (shared package later).
16. **Keyboard nav + ARIA labels** on every interactive control. Forms have
    `aria-describedby` on error messages.
17. **Dark mode default, light mode optional.** Driven by a single CSS var
    palette — no hex literals in components.
18. **Loading skeletons over spinners** for full-page loads — they preserve
    layout and feel faster.

### Errors

19. **Typed errors from `api()`:** `{ status, code, message, detail? }`.
    Components branch on `code`, never on `message` strings.
20. **Toast for transient errors, inline for form errors, full-page for 5xx
    or network down.** Never `console.log` and swallow.
21. **Sentry (or equivalent) wired via `VITE_SENTRY_DSN`** — optional in dev,
    required in prod. Don't bake the DSN in.

### Build + deploy

22. **`npm run build` must run with `--strict`** — no implicit `any`, no
    unused locals, no any-typed env access.
23. **Bundle size budget** in `vite.config.ts` — fail CI if > 250 KB gzipped
    for the entry chunk.
24. **No dev-only code in prod builds.** Guard with `import.meta.env.DEV`.

---

## 4. Pages

### Public
1. **`/`** — landing (lives on daemora.com today).
2. **`/signup`** — `AuthCard` in signup mode. Magic link toggle gated by
   `VITE_ENABLE_MAGIC_LINK`.
3. **`/login`** — same card, login mode.
4. **`/verify-email`** — landing for the verify link. Calls Better Auth,
   then redirects to `/welcome`.

### Authenticated
5. **`/welcome`** — first-run.
   - `POST /signup/start-trial` once (idempotent on backend, but UI guards
     with `useMutation` + key on user id).
   - Polls `GET /signup/status` until `tenant.status === "running"`.
   - Shows `OpenDaemoraButton` → `buildTenantUrl(tenant.slug)`.
6. **`/dashboard`** — home.
   - `TrialBanner` (hidden when `state === "active"`).
   - `TenantStatusPill` + `OpenDaemoraButton`.
   - Quick links: subscribe, billing, account.
7. **`/subscribe`** — plan picker.
   - Two `PlanCard`s. Click → `POST /signup/checkout` → `window.open(url)`,
     then route to `/payment-claim?plan=…`.
8. **`/payment-claim`** — Flow B form. `PaymentClaimForm` → `POST /billing/claim`.
9. **`/billing`** — `GET /billing/claims/mine`. Current plan + history of
   `ClaimRow`s with status pills.
10. **`/account`** — profile, password change, sign out.

### Edge
11. **`/trial-expired`** — soft wall when `state === "expired"`.
12. **`/payment-pending`** — friendly waiting state.

### Admin (separate auth)
13. **`/admin/claims`** — list of pending claims with confirm / reject. Uses
    `Authorization: Bearer <admin-token>` from a separate admin-only login
    flow (NOT the user cookie). Admin token is entered by the operator, never
    baked into the bundle.

---

## 5. Components

| Component             | Responsibility                                                              |
|-----------------------|------------------------------------------------------------------------------|
| `AuthCard`            | Signup / login / magic-link in one form, mode toggle                        |
| `TrialBanner`         | `{daysLeft}d left · Subscribe →` — sticky top                               |
| `TenantStatusPill`    | Colored chip — running / sleeping / suspended / provisioning                |
| `PlanCard`            | Price + features + CTA. Props: `plan`, `priceUsd`, `features[]`             |
| `PaymentClaimForm`    | TX id + plan select. Submits via `api()`                                    |
| `ClaimRow`            | One row of `/billing` list with status badge                                |
| `OpenDaemoraButton`   | Primary CTA → opens tenant URL in new tab                                   |
| `RequireAuth`         | Route guard — redirects to `/login` if no session                           |
| `RequireVerified`     | Wraps `RequireAuth` — also requires `user.emailVerified`                    |
| `ErrorBoundary`       | Top-level — catches render errors, shows `/error` fallback                  |
| `LoadingSkeleton`     | Generic block / list / card skeletons                                       |

---

## 6. The `api()` client — what it must look like

```ts
// apps/web/src/lib/env.ts
import { z } from "zod";
const Schema = z.object({
  VITE_API_BASE_URL: z.string().url(),
  VITE_TENANT_PROXY_URL: z.string().url(),
  VITE_TENANT_HOST_SUFFIX: z.string().default(".daemora.app"),
  VITE_POLL_INTERVAL_MS: z.coerce.number().int().min(500).default(3000),
  VITE_TRIAL_LENGTH_DAYS: z.coerce.number().int().min(1).default(7),
  VITE_ENABLE_MAGIC_LINK: z.coerce.boolean().default(true),
  VITE_DEFAULT_PLAN: z.enum(["lite", "pro"]).default("pro"),
  VITE_DAEMORA_BRAND: z.string().default("daemora"),
});
export const env = Schema.parse(import.meta.env);

// apps/web/src/lib/api.ts
import { env } from "./env";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public detail?: unknown) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${env.VITE_API_BASE_URL}${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? "unknown", body?.message ?? res.statusText, body?.detail);
  }
  return body as T;
}

// apps/web/src/lib/api-paths.ts
export const paths = {
  health: "/health",
  authSession: "/auth/get-session",
  signupStartTrial: "/signup/start-trial",
  signupStatus: "/signup/status",
  signupCheckout: "/signup/checkout",
  billingClaim: "/billing/claim",
  billingClaimsMine: "/billing/claims/mine",
} as const;

// apps/web/src/lib/tenant-url.ts
import { env } from "./env";
export function buildTenantUrl(slug: string): string {
  if (import.meta.env.DEV) {
    return `${env.VITE_TENANT_PROXY_URL}/?slug=${encodeURIComponent(slug)}`;
  }
  return `https://${slug}${env.VITE_TENANT_HOST_SUFFIX}`;
}
```

---

## 7. CORS + cookies — `apps/api` side

For local cross-origin (UI on `:5173`, API on `:8090`) the API must:

- Set `Access-Control-Allow-Origin: ${PUBLIC_APP_URL}` (exact, not `*`).
- Set `Access-Control-Allow-Credentials: true`.
- Set cookies with `SameSite=Lax` in dev, `SameSite=None; Secure` in prod.
- Allow `OPTIONS` preflight for all `/signup/*` and `/billing/*` routes.

Better Auth handles cookie attrs from `trustedOrigins`. Verify `apps/api/src/auth/auth.ts`
already lists `PUBLIC_APP_URL` there.

---

## 8. Suggested stack for `apps/web`

- **Vite 5 + React 18 + TypeScript strict**
- **TanStack Router** (file-based) + **TanStack Query**
- **Better Auth React client**
- **Tailwind CSS + shadcn/ui** (matches existing daemora-ts UI)
- **zod + react-hook-form** with `@hookform/resolvers/zod`
- **dayjs** for trial countdowns

---

## 9. Open questions to confirm before scaffolding

- Should the UI live in `apps/web/` (same monorepo) or a separate repo? You
  mentioned creating a new GitHub repo for the SaaS — clarify scope.
- Plan pricing — `Lite` price (you've shown `$19` for Pro; `Lite` TBD).
- Operator (admin) auth method — separate Better Auth role, or a static
  bearer token loaded into a private admin app?
- Tenant URL strategy in dev — header injection via control plane, or
  query-string slug? Pick one and pin it in `buildTenantUrl`.
