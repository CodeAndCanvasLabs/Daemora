/**
 * /billing routes — Contra payment-claim flow (Flow B).
 *
 *   POST /billing/claim                — user files claim for a paid Contra transaction
 *   GET  /billing/claims/mine          — caller's claim history
 *   POST /billing/admin/claim/:id/confirm  — operator confirms → activate sub
 *   POST /billing/admin/claim/:id/reject   — operator rejects
 *   GET  /billing/admin/claims         — operator queue
 *
 * Admin routes use the Better Auth session + `users.isAdmin` role.
 * NO static bearer — that was a footgun (single shared token, no audit
 * trail, hard to rotate).
 */

import { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";

import type { Auth } from "../auth/auth.js";
import type { DB } from "../db/client.js";
import { paymentClaims, subscriptions, type User } from "../db/schema.js";
import type { AuditLogger } from "../services/audit.js";
import { clientFingerprint } from "../services/audit.js";
import type { TrialService } from "../services/trial.js";

export interface BillingDeps {
  readonly db: DB;
  readonly trial: TrialService;
  readonly auth: Auth;
  readonly audit: AuditLogger;
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

    const fp = clientFingerprint(c.req.raw);
    await deps.audit.record({
      kind: "claim_filed",
      userId: user.id,
      detail: { transactionId: body.transactionId, plan: body.plan },
      ...fp,
    });

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

  // ── operator routes — gated by users.isAdmin ────────────────────

  const ConfirmBody = z.object({ plan: z.enum(["lite", "pro"]) });
  app.post("/admin/claim/:id/confirm", async (c) => {
    const operator = await requireAdmin(c, deps);
    if (!operator) return c.json({ error: "forbidden" }, 403);

    let body: z.infer<typeof ConfirmBody>;
    try { body = ConfirmBody.parse(await c.req.json()); }
    catch (e) { return c.json({ error: "bad_request", detail: (e as Error).message }, 400); }

    const id = c.req.param("id");
    const claim = await deps.db.select().from(paymentClaims).where(eq(paymentClaims.id, id)).limit(1).then((rs) => rs[0]);
    if (!claim) return c.json({ error: "not_found" }, 404);
    if (claim.status !== "pending") return c.json({ error: "wrong_state", status: claim.status }, 409);

    await deps.db
      .update(paymentClaims)
      .set({ status: "confirmed", confirmedAt: new Date(), confirmedBy: operator.id })
      .where(eq(paymentClaims.id, id));

    const sub = await deps.db.select().from(subscriptions).where(eq(subscriptions.userId, claim.userId)).limit(1).then((rs) => rs[0]);
    if (sub) await deps.trial.activatePaid(sub.id, body.plan, claim.transactionId);

    const fp = clientFingerprint(c.req.raw);
    await deps.audit.record({
      kind: "claim_confirmed",
      userId: operator.id,
      detail: { claimId: id, targetUserId: claim.userId, plan: body.plan, transactionId: claim.transactionId },
      ...fp,
    });
    return c.json({ ok: true });
  });

  const RejectBody = z.object({ reason: z.string().min(1).max(500) });
  app.post("/admin/claim/:id/reject", async (c) => {
    const operator = await requireAdmin(c, deps);
    if (!operator) return c.json({ error: "forbidden" }, 403);

    let body: z.infer<typeof RejectBody>;
    try { body = RejectBody.parse(await c.req.json()); }
    catch (e) { return c.json({ error: "bad_request", detail: (e as Error).message }, 400); }

    const id = c.req.param("id");
    const updated = await deps.db
      .update(paymentClaims)
      .set({ status: "rejected", rejectionReason: body.reason, confirmedAt: new Date(), confirmedBy: operator.id })
      .where(and(eq(paymentClaims.id, id), eq(paymentClaims.status, "pending")))
      .returning();
    if (updated.length === 0) return c.json({ error: "not_found_or_wrong_state" }, 404);

    const fp = clientFingerprint(c.req.raw);
    await deps.audit.record({
      kind: "claim_rejected",
      userId: operator.id,
      detail: { claimId: id, reason: body.reason },
      ...fp,
    });
    return c.json({ ok: true });
  });

  // GET /billing/admin/claims — operator queue
  app.get("/admin/claims", async (c) => {
    const operator = await requireAdmin(c, deps);
    if (!operator) return c.json({ error: "forbidden" }, 403);
    const rows = await deps.db.select().from(paymentClaims).where(eq(paymentClaims.status, "pending"));
    return c.json({ claims: rows });
  });

  return app;
}

// ── helpers ────────────────────────────────────────────────────────

async function requireUser(
  c: Parameters<Parameters<Hono["post"]>[1]>[0],
  deps: BillingDeps,
): Promise<User | null> {
  // Same pattern as the admin route — let Better Auth parse the cookie
  // header (handles `__Secure-` prefix, HMAC verify, expiry).
  const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
  return (session?.user ?? null) as User | null;
}

async function requireAdmin(
  c: Parameters<Parameters<Hono["post"]>[1]>[0],
  deps: BillingDeps,
): Promise<User | null> {
  const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
  const u = session?.user as (User & { isAdmin?: boolean }) | undefined;
  if (!u || !u.isAdmin) return null;
  return u;
}
