/**
 * /billing routes — handles the Contra payment-claim flow (Flow B).
 *
 *   POST /billing/claim   { transactionId, plan }
 *     User pasted their Contra receipt id after paying.
 *     We record a pending_claim. Operator (or automated job once Contra
 *     adds API) reconciles and confirms.
 *
 *   POST /admin/claim/:id/confirm   { plan }
 *     Operator marks a claim confirmed → activate subscription.
 *
 *   POST /admin/claim/:id/reject    { reason }
 */

import { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";

import type { DB } from "../db/client.js";
import { paymentClaims, subscriptions, type User } from "../db/schema.js";
import type { TrialService } from "../services/trial.js";

export interface BillingDeps {
  readonly db: DB;
  readonly trial: TrialService;
  readonly getUser: (token: string) => Promise<User | null>;
  readonly adminToken: string;          // CONTROL_PLANE_ADMIN_TOKEN — reused for operator routes
}

export function buildBillingRoutes(deps: BillingDeps): Hono {
  const app = new Hono();

  // POST /billing/claim
  const ClaimBody = z.object({
    transactionId: z.string().min(4).max(128),
    plan: z.enum(["lite", "pro"]),
  });
  app.post("/claim", async (c) => {
    const user = await requireUser(c, deps);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    let body: z.infer<typeof ClaimBody>;
    try { body = ClaimBody.parse(await c.req.json()); }
    catch (e) { return c.json({ error: "bad_request", detail: (e as Error).message }, 400); }

    // Reject duplicates (someone trying to reuse a claim).
    const existing = await deps.db
      .select()
      .from(paymentClaims)
      .where(eq(paymentClaims.transactionId, body.transactionId))
      .limit(1);
    if (existing.length > 0) {
      return c.json({ error: "duplicate_claim", status: existing[0]!.status }, 409);
    }

    const inserted = await deps.db
      .insert(paymentClaims)
      .values({
        userId: user.id,
        transactionId: body.transactionId,
        plan: body.plan,
        status: "pending",
      })
      .returning();

    return c.json({ claim: inserted[0], state: "pending" });
  });

  // GET /billing/claims/mine
  app.get("/claims/mine", async (c) => {
    const user = await requireUser(c, deps);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const rows = await deps.db
      .select()
      .from(paymentClaims)
      .where(eq(paymentClaims.userId, user.id));
    return c.json({ claims: rows });
  });

  // ── operator routes ─────────────────────────────────────────────

  const ConfirmBody = z.object({
    plan: z.enum(["lite", "pro"]),
  });
  app.post("/admin/claim/:id/confirm", async (c) => {
    if (!requireAdmin(c, deps.adminToken)) return c.json({ error: "unauthorized" }, 401);
    let body: z.infer<typeof ConfirmBody>;
    try { body = ConfirmBody.parse(await c.req.json()); }
    catch (e) { return c.json({ error: "bad_request", detail: (e as Error).message }, 400); }

    const id = c.req.param("id");
    const claim = await deps.db
      .select()
      .from(paymentClaims)
      .where(eq(paymentClaims.id, id))
      .limit(1)
      .then((rs) => rs[0]);
    if (!claim) return c.json({ error: "not_found" }, 404);
    if (claim.status !== "pending") return c.json({ error: "wrong_state", status: claim.status }, 409);

    // Mark claim confirmed + activate the user's subscription.
    await deps.db
      .update(paymentClaims)
      .set({ status: "confirmed", confirmedAt: new Date() })
      .where(eq(paymentClaims.id, id));

    const sub = await deps.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, claim.userId))
      .limit(1)
      .then((rs) => rs[0]);
    if (sub) {
      await deps.trial.activatePaid(sub.id, body.plan, claim.transactionId);
    }

    return c.json({ ok: true });
  });

  const RejectBody = z.object({ reason: z.string().min(1).max(500) });
  app.post("/admin/claim/:id/reject", async (c) => {
    if (!requireAdmin(c, deps.adminToken)) return c.json({ error: "unauthorized" }, 401);
    let body: z.infer<typeof RejectBody>;
    try { body = RejectBody.parse(await c.req.json()); }
    catch (e) { return c.json({ error: "bad_request", detail: (e as Error).message }, 400); }

    const id = c.req.param("id");
    const updated = await deps.db
      .update(paymentClaims)
      .set({ status: "rejected", rejectionReason: body.reason, confirmedAt: new Date() })
      .where(and(eq(paymentClaims.id, id), eq(paymentClaims.status, "pending")))
      .returning();
    if (updated.length === 0) return c.json({ error: "not_found_or_wrong_state" }, 404);
    return c.json({ ok: true });
  });

  // GET /billing/admin/claims  — operator view of all pending claims
  app.get("/admin/claims", (c) => {
    if (!requireAdmin(c, deps.adminToken)) return c.json({ error: "unauthorized" }, 401);
    return deps.db
      .select()
      .from(paymentClaims)
      .where(eq(paymentClaims.status, "pending"))
      .then((rows) => c.json({ claims: rows }));
  });

  return app;
}

async function requireUser(
  c: Parameters<Parameters<Hono["post"]>[1]>[0],
  deps: BillingDeps,
): Promise<User | null> {
  const raw = c.req.header("authorization")?.replace(/^Bearer\s+/i, "")
    ?? c.req.header("cookie")?.split(";").map((s) => s.trim()).find((s) => s.startsWith("daemora.session_token="))?.split("=")[1]
    ?? "";
  if (!raw) return null;
  return deps.getUser(decodeURIComponent(raw));
}

function requireAdmin(
  c: Parameters<Parameters<Hono["post"]>[1]>[0],
  adminToken: string,
): boolean {
  const auth = c.req.header("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return false;
  return constantTimeEqual(auth.slice(7).trim(), adminToken);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
