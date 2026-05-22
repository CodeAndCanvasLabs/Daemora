/**
 * /signup endpoints sit alongside Better Auth's mounted routes. Better
 * Auth handles password creation, verification email, login. We add:
 *
 *   POST /signup/start-trial    — after email-verify, create trial sub + provision tenant
 *   GET  /signup/status         — caller checks current trial state
 *   POST /signup/checkout       — return a Contra payment-link URL
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { DB } from "../db/client.js";
import { tenants, users, type User } from "../db/schema.js";
import type { ControlPlaneClient } from "../services/controlPlaneClient.js";
import type { TrialService } from "../services/trial.js";
import type { BillingProvider } from "../services/billing.js";

export interface SignupDeps {
  readonly db: DB;
  readonly controlPlane: ControlPlaneClient;
  readonly trial: TrialService;
  readonly billing: BillingProvider;
  readonly getUser: (token: string) => Promise<User | null>;       // bridge to Better Auth
}

export function buildSignupRoutes(deps: SignupDeps): Hono {
  const app = new Hono();

  // POST /signup/start-trial
  // Called by the UI right after email verification. Provisions the
  // tenant Machine and creates the 7-day trial subscription row.
  app.post("/start-trial", async (c) => {
    const user = await requireUser(c, deps);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    if (!user.emailVerified) return c.json({ error: "email_not_verified" }, 403);

    // Check we haven't already provisioned this user.
    const existing = await deps.db.select().from(tenants).where(eq(tenants.userId, user.id)).limit(1);
    if (existing.length > 0) {
      const t = existing[0]!;
      return c.json({ tenant: t, alreadyProvisioned: true });
    }

    // Create the subscription first — if provisioning fails, we still
    // have a record we can retry against.
    const sub = await deps.trial.startTrial(user.id);

    // Tell the control plane to create + start the tenant.
    let provision;
    try {
      provision = await deps.controlPlane.provision({
        email: user.email,
        plan: "trial",
      });
    } catch (err) {
      return c.json({ error: "provision_failed", detail: (err as Error).message }, 502);
    }

    // Persist the tenant row.
    const inserted = await deps.db
      .insert(tenants)
      .values({
        userId: user.id,
        slug: provision.slug,
        status: "running",
        lastActiveAt: new Date(),
      })
      .returning();

    return c.json({ tenant: inserted[0], subscription: sub });
  });

  // GET /signup/status — current trial / subscription state
  app.get("/status", async (c) => {
    const user = await requireUser(c, deps);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const status = await deps.trial.statusFor(user.id);
    const tenantRows = await deps.db.select().from(tenants).where(eq(tenants.userId, user.id)).limit(1);
    return c.json({ user, trial: status, tenant: tenantRows[0] ?? null });
  });

  // POST /signup/checkout  { plan: "lite" | "pro" }
  // Returns a Contra payment-link URL the UI can redirect to.
  const CheckoutBody = z.object({ plan: z.enum(["lite", "pro"]) });
  app.post("/checkout", async (c) => {
    const user = await requireUser(c, deps);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    let body: z.infer<typeof CheckoutBody>;
    try {
      body = CheckoutBody.parse(await c.req.json());
    } catch (e) {
      return c.json({ error: "bad_request", detail: (e as Error).message }, 400);
    }
    const session = await deps.billing.createCheckoutSession({
      userId: user.id,
      userEmail: user.email,
      plan: body.plan,
    });
    return c.json(session);
  });

  return app;
}

async function requireUser(
  c: Parameters<Parameters<Hono["post"]>[1]>[0],
  deps: SignupDeps,
): Promise<User | null> {
  // We treat the daemora session cookie (set by Better Auth) as auth.
  // The cookie name is `daemora.session_token` by default.
  const raw = c.req.header("authorization")?.replace(/^Bearer\s+/i, "")
    ?? c.req.header("cookie")?.split(";").map((s) => s.trim()).find((s) => s.startsWith("daemora.session_token="))?.split("=")[1]
    ?? "";
  if (!raw) return null;
  return deps.getUser(decodeURIComponent(raw));
}
