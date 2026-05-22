/**
 * Phase 10 — Billing tests.
 *
 *  - ContraProvider returns the configured payment-link URL per plan
 *  - FakeBillingProvider captures created sessions
 *  - Billing routes: POST /billing/claim records pending, rejects dup
 *  - Admin routes: confirm/reject auth-gated; confirm activates sub
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { ContraProvider, FakeBillingProvider } from "../src/services/billing.js";
import { buildBillingRoutes } from "../src/routes/billing.js";
import { paymentClaims, subscriptions, users, type User } from "../src/db/schema.js";
import { TrialService } from "../src/services/trial.js";
import { AuditLogger } from "../src/services/audit.js";
import type { Auth } from "../src/auth/auth.js";
import { makeTestDb } from "./helpers.js";
import type { DB } from "../src/db/client.js";

describe("ContraProvider", () => {
  it("returns the link configured for a plan", async () => {
    const p = new ContraProvider({ links: { pro: "https://contra.example/pro" } });
    const session = await p.createCheckoutSession({
      userId: "u1",
      userEmail: "a@x.com",
      plan: "pro",
    });
    expect(session.url).toBe("https://contra.example/pro");
    expect(session.provider).toBe("contra");
  });

  it("throws for an unconfigured plan", async () => {
    const p = new ContraProvider({ links: { lite: "https://contra.example/lite" } });
    await expect(p.createCheckoutSession({ userId: "u1", userEmail: "a@x.com", plan: "pro" }))
      .rejects.toThrow(/No Contra payment link/);
  });
});

describe("FakeBillingProvider", () => {
  it("captures created sessions", async () => {
    const p = new FakeBillingProvider();
    await p.createCheckoutSession({ userId: "u1", userEmail: "a@x.com", plan: "pro" });
    await p.createCheckoutSession({ userId: "u2", userEmail: "b@x.com", plan: "lite" });
    expect(p.created).toHaveLength(2);
    expect(p.created[0]?.plan).toBe("pro");
  });
});

describe("Billing routes", () => {
  let db: DB;
  let trial: TrialService;
  let app: Hono;
  let userId: string;
  let adminUserId: string;

  /** Fake Better Auth — tests pass a `daemora.session_token` cookie carrying the user id. */
  function fakeAuth(): Auth {
    return {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const cookie = headers.get("cookie") ?? "";
          const m = /daemora\.session_token=([^;]+)/.exec(cookie);
          if (!m) return null;
          const rows = await db.select().from(users).where(eq(users.id, decodeURIComponent(m[1]!))).limit(1);
          const u = rows[0];
          return u ? { user: u } : null;
        },
      },
    } as unknown as Auth;
  }

  async function callJson(
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: unknown }> {
    const res = await app.request(path, init);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  beforeEach(async () => {
    const ctx = makeTestDb();
    db = ctx.db;
    trial = new TrialService(db);

    // Seed a regular user + a separate admin user.
    userId = randomUUID();
    adminUserId = randomUUID();
    await db.insert(users).values({ id: userId, email: "a@x.com", emailVerified: true });
    await db.insert(users).values({ id: adminUserId, email: "op@x.com", emailVerified: true, isAdmin: true });

    app = new Hono();
    app.route(
      "/billing",
      buildBillingRoutes({
        db,
        trial,
        getUser: async (token) => {
          if (!token) return null;
          const r = await db.select().from(users).where(eq(users.id, token)).limit(1);
          return r[0] ?? null;
        },
        auth: fakeAuth(),
        audit: new AuditLogger(db),
      }),
    );
  });

  it("POST /billing/claim records a pending claim", async () => {
    const r = await callJson("/billing/claim", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `daemora.session_token=${userId}`,
      },
      body: JSON.stringify({ transactionId: "contra-tx-abc", plan: "pro" }),
    });
    expect(r.status).toBe(200);
    const body = r.body as { claim: { status: string }; state: string };
    expect(body.claim.status).toBe("pending");
    expect(body.state).toBe("pending");
  });

  it("POST /billing/claim rejects duplicate transactionId", async () => {
    await callJson("/billing/claim", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `daemora.session_token=${userId}` },
      body: JSON.stringify({ transactionId: "contra-tx-dup", plan: "pro" }),
    });
    const r = await callJson("/billing/claim", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `daemora.session_token=${userId}` },
      body: JSON.stringify({ transactionId: "contra-tx-dup", plan: "pro" }),
    });
    expect(r.status).toBe(409);
  });

  it("POST /billing/claim rejects unauthenticated requests", async () => {
    const r = await callJson("/billing/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transactionId: "tx-1", plan: "pro" }),
    });
    expect(r.status).toBe(401);
  });

  it("POST /billing/admin/claim/:id/confirm activates the user's subscription", async () => {
    // user starts a trial; then files a claim.
    const sub = await trial.startTrial(userId);
    const claimResp = await callJson("/billing/claim", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `daemora.session_token=${userId}` },
      body: JSON.stringify({ transactionId: "contra-tx-confirm", plan: "pro" }),
    });
    const claimId = (claimResp.body as { claim: { id: string } }).claim.id;

    // Operator confirms — signed in as admin user (isAdmin=true).
    const r = await callJson(`/billing/admin/claim/${claimId}/confirm`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `daemora.session_token=${adminUserId}`,
      },
      body: JSON.stringify({ plan: "pro" }),
    });
    expect(r.status).toBe(200);

    // Subscription is now active.
    const updated = await db.select().from(subscriptions).where(eq(subscriptions.id, sub.id)).limit(1);
    expect(updated[0]?.status).toBe("active");
    expect(updated[0]?.plan).toBe("pro");
    expect(updated[0]?.externalId).toBe("contra-tx-confirm");

    // And the claim is marked confirmed.
    const c = await db.select().from(paymentClaims).where(eq(paymentClaims.id, claimId)).limit(1);
    expect(c[0]?.status).toBe("confirmed");
  });

  it("POST /billing/admin/claim/:id/confirm rejects non-admin users (403)", async () => {
    const claimResp = await callJson("/billing/claim", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `daemora.session_token=${userId}` },
      body: JSON.stringify({ transactionId: "contra-tx-noauth", plan: "pro" }),
    });
    const claimId = (claimResp.body as { claim: { id: string } }).claim.id;
    // Regular user (isAdmin=false) tries to confirm — 403.
    const r = await callJson(`/billing/admin/claim/${claimId}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `daemora.session_token=${userId}` },
      body: JSON.stringify({ plan: "pro" }),
    });
    expect(r.status).toBe(403);
  });

  it("POST /billing/admin/claim/:id/reject moves claim to rejected", async () => {
    const claimResp = await callJson("/billing/claim", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `daemora.session_token=${userId}` },
      body: JSON.stringify({ transactionId: "contra-tx-reject", plan: "pro" }),
    });
    const claimId = (claimResp.body as { claim: { id: string } }).claim.id;
    const r = await callJson(`/billing/admin/claim/${claimId}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `daemora.session_token=${adminUserId}` },
      body: JSON.stringify({ reason: "not-found-in-contra" }),
    });
    expect(r.status).toBe(200);
    const c = await db.select().from(paymentClaims).where(eq(paymentClaims.id, claimId)).limit(1);
    expect(c[0]?.status).toBe("rejected");
    expect(c[0]?.rejectionReason).toBe("not-found-in-contra");
  });

  it("GET /billing/claims/mine returns only the caller's claims", async () => {
    await callJson("/billing/claim", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `daemora.session_token=${userId}` },
      body: JSON.stringify({ transactionId: "contra-tx-mine-1", plan: "pro" }),
    });
    const r = await callJson("/billing/claims/mine", {
      method: "GET",
      headers: { cookie: `daemora.session_token=${userId}` },
    });
    expect(r.status).toBe(200);
    const body = r.body as { claims: Array<{ userId: string; transactionId: string }> };
    expect(body.claims).toHaveLength(1);
    expect(body.claims[0]?.userId).toBe(userId);
  });
});
