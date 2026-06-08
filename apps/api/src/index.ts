/**
 * apps/api — Hono entrypoint.
 *
 * Boots:
 *  - Postgres + Drizzle
 *  - Better Auth (mounted at /auth/*)
 *  - /signup/*, /billing/* route groups
 *  - Trial cron (every 5 minutes in prod; disabled in tests)
 *  - Resend-backed email sender
 *  - Pluggable BillingProvider — Contra
 */

import { Hono } from "hono";
import { cors } from "hono/cors";

import { buildOrchestrator } from "./gateway/orchestrator.js";
import { createGatewayServer } from "./gateway/server.js";

import { buildAuth, type Auth } from "./auth/auth.js";
import { getDb } from "./db/client.js";
import { loadEnv, type Env } from "./lib/env.js";
import { authRateLimit, buildSecureHeaders, readRateLimit } from "./lib/security.js";
import { buildAgentRoutes } from "./routes/agents.js";
import { buildConfigRoutes } from "./routes/config.js";
import { buildBillingRoutes } from "./routes/billing.js";
import { buildInternalRoutes } from "./routes/internal.js";
import { buildSignupRoutes } from "./routes/signup.js";
import { AuditLogger, clientFingerprint } from "./services/audit.js";
import { ContraProvider } from "./services/billing.js";
import { InMemorySender, ResendSender, type EmailSender } from "./services/email.js";
import { managerProvisioner, type TenantProvisioner } from "./services/provision.js";
import { TrialService } from "./services/trial.js";
import { runTrialJob } from "./services/trialJob.js";
import type { TenantManager } from "../../../src/multitenant/TenantManager.js";
import { createLogger } from "../../../src/util/logger.js";

const log = createLogger("apps.api");

/**
 * Keep the gateway alive through transient network errors. A long-running
 * multi-tenant server must NOT die because a peer reset a TLS socket (idle
 * Postgres connection, client disconnect, etc.) — that would 503 every tenant.
 * Benign network codes are logged and swallowed; anything else is logged and
 * re-thrown so a process manager can restart cleanly.
 */
function installCrashGuards(): void {
  const BENIGN = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED", "ERR_STREAM_PREMATURE_CLOSE"]);
  process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
    if (err.code && BENIGN.has(err.code)) { log.warn({ code: err.code, msg: err.message }, "ignored transient network error"); return; }
    log.error({ msg: err.message, stack: err.stack }, "uncaught exception — exiting for restart");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    const e = reason as NodeJS.ErrnoException;
    if (e?.code && BENIGN.has(e.code)) { log.warn({ code: e.code }, "ignored transient network rejection"); return; }
    log.error({ reason: e?.message ?? String(reason) }, "unhandled rejection");
  });
}

export interface ApiDeps {
  readonly env: Env;
  readonly email: EmailSender;          // overridable for tests
}

export function buildApp(deps: ApiDeps): { app: Hono; auth: Auth; trial: TrialService; provisioner: TenantProvisioner; manager: TenantManager } {
  const { db, client } = getDb(deps.env.DATABASE_URL);
  const auth = buildAuth({
    db,
    secret: deps.env.SESSION_COOKIE_SECRET,
    apiUrl: deps.env.PUBLIC_API_URL,
    appUrl: deps.env.PUBLIC_APP_URL,
    email: deps.email,
    trustedOrigins: [deps.env.PUBLIC_APP_URL, deps.env.PUBLIC_API_URL],
  });

  const trial = new TrialService(db);
  // Single-ingress gateway: run the tenant orchestrator IN-PROCESS instead of
  // calling a separate control-plane service. Provisioning + suspend go through
  // the manager-backed provisioner port.
  const manager = buildOrchestrator(deps.env, client, db);
  const provisioner = managerProvisioner(manager);
  const billing = new ContraProvider({
    links: {
      ...(deps.env.CONTRA_PAYMENT_LINK_LITE ? { lite: deps.env.CONTRA_PAYMENT_LINK_LITE } : {}),
      ...(deps.env.CONTRA_PAYMENT_LINK_PRO ? { pro: deps.env.CONTRA_PAYMENT_LINK_PRO } : {}),
    },
  });

  const audit = new AuditLogger(db);
  const app = new Hono();
  const isProd = deps.env.NODE_ENV === "production";

  // Security headers — CSP, HSTS (prod only), X-Frame-Options, etc.
  app.use("*", buildSecureHeaders(isProd));

  // CORS — UI lives on a different origin in dev (5173) and the cookie
  // flow needs credentials: true + an exact origin (no '*').
  app.use(
    "*",
    cors({
      origin: deps.env.PUBLIC_APP_URL,
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["content-type", "authorization"],
    }),
  );

  app.get("/health", (c) => c.json({ ok: true, service: "apps/api", env: deps.env.NODE_ENV }));

  // Rate limit auth-sensitive paths (signup / signin / magic-link / verify-email).
  // Mounted BEFORE Better Auth so rejected attempts don't even hit it.
  app.use("/api/auth/sign-up/*", authRateLimit);
  app.use("/api/auth/sign-in/*", authRateLimit);
  app.use("/api/auth/forget-password", authRateLimit);
  app.use("/api/auth/reset-password", authRateLimit);
  app.use("/api/auth/verify-email", readRateLimit);

  // Audit successful auth events. We hook AFTER Better Auth handles the
  // request so we can read the response status + log the user from the
  // resulting session.
  app.use("/api/auth/sign-up/email", async (c, next) => {
    await next();
    if (c.res.status === 200) {
      const { ipAddress, userAgent } = clientFingerprint(c.req.raw);
      await audit.record({ kind: "signup", ipAddress, userAgent });
    }
  });
  app.use("/api/auth/sign-in/*", async (c, next) => {
    await next();
    if (c.res.status === 200) {
      const { ipAddress, userAgent } = clientFingerprint(c.req.raw);
      await audit.record({ kind: "signin", ipAddress, userAgent });
    }
  });
  app.use("/api/auth/sign-out", async (c, next) => {
    await next();
    if (c.res.status === 200) {
      const { ipAddress, userAgent } = clientFingerprint(c.req.raw);
      await audit.record({ kind: "signout", ipAddress, userAgent });
    }
  });

  // Mount Better Auth at /api/auth/* (matches Better Auth's default
  // basePath; React client + curl snippets work without overrides).
  app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.route("/signup", buildSignupRoutes({
    db,
    controlPlane: provisioner,             // in-process tenant manager (was the split control plane)
    trial,
    billing,
    auth,                                  // session validation goes through Better Auth, no custom parsing
  }));

  app.route("/billing", buildBillingRoutes({
    db,
    trial,
    auth,                                  // user + admin checks both go through Better Auth's getSession
    audit,
  }));

  app.route("/agents", buildAgentRoutes({
    db,
    auth,                                  // roster scoped to the authed user via getSession
  }));

  // The ONE unified config endpoint (central Postgres source of truth).
  // manager + signingSecret enable live-apply to the running tenant (no restart).
  app.route("/api/me", buildConfigRoutes({
    db,
    auth,
    manager,
    ...(deps.env.INTERNAL_SIGNING_SECRET ? { signingSecret: deps.env.INTERNAL_SIGNING_SECRET } : {}),
  }));

  // Internal gateway→tenant API (secret broker). Guarded by the signed identity.
  app.route("/internal", buildInternalRoutes({
    manager,
    ...(deps.env.INTERNAL_SIGNING_SECRET ? { signingSecret: deps.env.INTERNAL_SIGNING_SECRET } : {}),
  }));

  return { app, auth, trial, provisioner, manager };
}

/** Production entry. */
export async function startApi(): Promise<void> {
  installCrashGuards();
  const env = loadEnv();
  const email = env.RESEND_API_KEY
    ? new ResendSender(env.RESEND_API_KEY, env.RESEND_FROM_EMAIL)
    : new InMemorySender();

  // buildApp constructs the in-process tenant orchestrator (manager) + the
  // provisioner port; the gateway server + trial cron reuse them.
  const { app, auth, trial, provisioner, manager } = buildApp({ env, email });
  const { db } = getDb(env.DATABASE_URL);

  // Hydrate the Postgres-backed tenant registry cache before accepting traffic
  // (#25 — replaces the old SQLite tenants.db). Routing reads from this cache.
  await manager.init();

  // Trial automation cron — every 5 min.
  const interval = setInterval(() => {
    void runTrialJob({
      db: getDb(env.DATABASE_URL).db,
      trial,
      email,
      controlPlane: provisioner,
      subscribeUrl: `${env.PUBLIC_APP_URL}/subscribe`,
    }).catch(() => { /* logged inside */ });
  }, 5 * 60 * 1000);
  (interval as { unref?: () => void }).unref?.();

  const server = createGatewayServer({
    db,
    auth,
    manager,
    honoFetch: app.fetch,
    ...(env.INTERNAL_SIGNING_SECRET ? { signingSecret: env.INTERNAL_SIGNING_SECRET } : {}),
  });
  server.listen(env.PORT, () => {
    console.log(`[gateway] listening on :${env.PORT} (runtime=${env.DAEMORA_RUNTIME})`);
  });
}

// Run if invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  startApi().catch((err) => {
    console.error("apps/api failed to start:", err);
    process.exit(1);
  });
}
