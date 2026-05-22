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

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { buildAuth, type Auth } from "./auth/auth.js";
import { getDb } from "./db/client.js";
import { loadEnv, type Env } from "./lib/env.js";
import { authRateLimit, buildSecureHeaders, readRateLimit } from "./lib/security.js";
import { buildBillingRoutes } from "./routes/billing.js";
import { buildSignupRoutes } from "./routes/signup.js";
import { AuditLogger, clientFingerprint } from "./services/audit.js";
import { ContraProvider } from "./services/billing.js";
import { ControlPlaneClient } from "./services/controlPlaneClient.js";
import { InMemorySender, ResendSender, type EmailSender } from "./services/email.js";
import { TrialService } from "./services/trial.js";
import { runTrialJob } from "./services/trialJob.js";

export interface ApiDeps {
  readonly env: Env;
  readonly email: EmailSender;          // overridable for tests
}

export function buildApp(deps: ApiDeps): { app: Hono; auth: Auth; trial: TrialService; controlPlane: ControlPlaneClient } {
  const { db } = getDb(deps.env.DATABASE_URL);
  const auth = buildAuth({
    db,
    secret: deps.env.SESSION_COOKIE_SECRET,
    apiUrl: deps.env.PUBLIC_API_URL,
    appUrl: deps.env.PUBLIC_APP_URL,
    email: deps.email,
    trustedOrigins: [deps.env.PUBLIC_APP_URL, deps.env.PUBLIC_API_URL],
  });

  const trial = new TrialService(db);
  const controlPlane = new ControlPlaneClient({
    baseUrl: deps.env.CONTROL_PLANE_INTERNAL_URL,
    adminToken: deps.env.CONTROL_PLANE_ADMIN_TOKEN,
  });
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
      allowMethods: ["GET", "POST", "OPTIONS"],
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
    controlPlane,
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

  return { app, auth, trial, controlPlane };
}

/** Production entry. */
export async function startApi(): Promise<void> {
  const env = loadEnv();
  const email = env.RESEND_API_KEY
    ? new ResendSender(env.RESEND_API_KEY, env.RESEND_FROM_EMAIL)
    : new InMemorySender();

  const { app, trial, controlPlane } = buildApp({ env, email });

  // Trial automation cron — every 5 min.
  const interval = setInterval(() => {
    void runTrialJob({
      db: getDb(env.DATABASE_URL).db,
      trial,
      email,
      controlPlane,
      subscribeUrl: `${env.PUBLIC_APP_URL}/subscribe`,
    }).catch(() => { /* logged inside */ });
  }, 5 * 60 * 1000);
  (interval as { unref?: () => void }).unref?.();

  serve({
    fetch: app.fetch,
    port: env.PORT,
  });

  console.log(`[apps/api] listening on :${env.PORT}`);
}

// Run if invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  startApi().catch((err) => {
    console.error("apps/api failed to start:", err);
    process.exit(1);
  });
}
