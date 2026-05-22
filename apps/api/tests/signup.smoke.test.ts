/**
 * Phase 8 — Signup route tests.
 *
 *  - POST /signup/start-trial   provisions tenant via control plane + creates trial sub
 *  - POST /signup/start-trial   blocks unverified emails
 *  - POST /signup/start-trial   is idempotent (returns existing tenant)
 *  - GET  /signup/status        reflects trial state + tenant row
 *  - POST /signup/checkout      returns Contra link from the BillingProvider
 *  - all routes require auth (cookie or bearer)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { buildSignupRoutes } from "../src/routes/signup.js";
import { ControlPlaneClient } from "../src/services/controlPlaneClient.js";
import { FakeBillingProvider } from "../src/services/billing.js";
import { TrialService } from "../src/services/trial.js";
import { subscriptions, tenants, users } from "../src/db/schema.js";
import { makeTestDb } from "./helpers.js";
import type { DB } from "../src/db/client.js";

let db: DB;
let trial: TrialService;
let billing: FakeBillingProvider;
let app: Hono;
let userId: string;

interface FakeFetchOpts {
  fail?: boolean;
  body?: unknown;
}

function fakeFetch(opts: FakeFetchOpts = {}): { fetch: typeof fetch } {
  const f: typeof fetch = async (input, _init) => {
    if (opts.fail) return new Response("boom", { status: 500 });
    const url = String(input);
    if (url.endsWith("/admin/tenants") && _init?.method === "POST") {
      return new Response(JSON.stringify(
        opts.body ?? {
          id: randomUUID(),
          slug: `tenant-${randomUUID().slice(0, 8)}`,
          port: 8101,
          status: "running",
          dataDir: "/srv/t",
        },
      ), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return { fetch: f };
}

async function callJson(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const res = await app.request(path, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function buildAppWithFetch(ff: typeof fetch): Hono {
  const cp = new ControlPlaneClient({ baseUrl: "http://cp", adminToken: "t", fetch: ff });
  const h = new Hono();
  h.route(
    "/signup",
    buildSignupRoutes({
      db,
      controlPlane: cp,
      trial,
      billing,
      getUser: async (token) => {
        if (!token) return null;
        const r = await db.select().from(users).where(eq(users.id, token)).limit(1);
        return r[0] ?? null;
      },
    }),
  );
  return h;
}

beforeEach(async () => {
  const ctx = makeTestDb();
  db = ctx.db;
  trial = new TrialService(db);
  billing = new FakeBillingProvider();

  userId = randomUUID();
  await db.insert(users).values({ id: userId, email: "alice@x.com", emailVerified: true });

  app = buildAppWithFetch(fakeFetch().fetch);
});

describe("POST /signup/start-trial", () => {
  it("provisions a tenant and creates a trial subscription", async () => {
    const r = await callJson("/signup/start-trial", {
      method: "POST",
      headers: { cookie: `daemora.session_token=${userId}` },
    });
    expect(r.status).toBe(200);
    const body = r.body as { tenant: { slug: string; status: string }; subscription: { plan: string } };
    expect(body.tenant.slug).toMatch(/^tenant-/);
    expect(body.tenant.status).toBe("running");
    expect(body.subscription.plan).toBe("trial");

    const sub = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1);
    expect(sub[0]?.status).toBe("trialing");
  });

  it("rejects unauthenticated callers (401)", async () => {
    const r = await callJson("/signup/start-trial", { method: "POST" });
    expect(r.status).toBe(401);
  });

  it("rejects users whose email is not verified (403)", async () => {
    const unverified = randomUUID();
    await db.insert(users).values({ id: unverified, email: "bob@x.com", emailVerified: false });

    const r = await callJson("/signup/start-trial", {
      method: "POST",
      headers: { cookie: `daemora.session_token=${unverified}` },
    });
    expect(r.status).toBe(403);
    expect((r.body as { error: string }).error).toBe("email_not_verified");
  });

  it("is idempotent — second call returns alreadyProvisioned=true", async () => {
    const first = await callJson("/signup/start-trial", {
      method: "POST",
      headers: { cookie: `daemora.session_token=${userId}` },
    });
    expect(first.status).toBe(200);

    const second = await callJson("/signup/start-trial", {
      method: "POST",
      headers: { cookie: `daemora.session_token=${userId}` },
    });
    expect(second.status).toBe(200);
    expect((second.body as { alreadyProvisioned: boolean }).alreadyProvisioned).toBe(true);

    const allTenants = await db.select().from(tenants).where(eq(tenants.userId, userId));
    expect(allTenants).toHaveLength(1);
  });

  it("returns 502 when the control plane fails to provision", async () => {
    app = buildAppWithFetch(fakeFetch({ fail: true }).fetch);
    const r = await callJson("/signup/start-trial", {
      method: "POST",
      headers: { cookie: `daemora.session_token=${userId}` },
    });
    expect(r.status).toBe(502);
    expect((r.body as { error: string }).error).toBe("provision_failed");
  });

  it("accepts Authorization: Bearer as well as cookie", async () => {
    const r = await callJson("/signup/start-trial", {
      method: "POST",
      headers: { authorization: `Bearer ${userId}` },
    });
    expect(r.status).toBe(200);
  });
});

describe("GET /signup/status", () => {
  it("returns 'none' before any trial is started", async () => {
    const r = await callJson("/signup/status", {
      method: "GET",
      headers: { cookie: `daemora.session_token=${userId}` },
    });
    expect(r.status).toBe(200);
    const body = r.body as { trial: { state: string }; tenant: unknown };
    expect(body.trial.state).toBe("none");
    expect(body.tenant).toBeNull();
  });

  it("reflects trialing + tenant after start-trial", async () => {
    await callJson("/signup/start-trial", {
      method: "POST",
      headers: { cookie: `daemora.session_token=${userId}` },
    });
    const r = await callJson("/signup/status", {
      method: "GET",
      headers: { cookie: `daemora.session_token=${userId}` },
    });
    const body = r.body as {
      trial: { state: string; daysLeft: number };
      tenant: { slug: string; status: string } | null;
    };
    expect(body.trial.state).toBe("trialing");
    expect(body.trial.daysLeft).toBeGreaterThan(0);
    expect(body.tenant?.status).toBe("running");
  });

  it("rejects unauthenticated requests (401)", async () => {
    const r = await callJson("/signup/status", { method: "GET" });
    expect(r.status).toBe(401);
  });
});

describe("POST /signup/checkout", () => {
  it("returns a checkout session URL for a valid plan", async () => {
    const r = await callJson("/signup/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `daemora.session_token=${userId}` },
      body: JSON.stringify({ plan: "pro" }),
    });
    expect(r.status).toBe(200);
    const body = r.body as { url: string; provider: string };
    expect(body.provider).toBe("contra");
    expect(body.url).toContain("pro");
    expect(billing.created).toHaveLength(1);
    expect(billing.created[0]?.plan).toBe("pro");
    expect(billing.created[0]?.userEmail).toBe("alice@x.com");
  });

  it("rejects unknown plans (400)", async () => {
    const r = await callJson("/signup/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `daemora.session_token=${userId}` },
      body: JSON.stringify({ plan: "enterprise" }),
    });
    expect(r.status).toBe(400);
  });

  it("rejects unauthenticated requests (401)", async () => {
    const r = await callJson("/signup/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: "lite" }),
    });
    expect(r.status).toBe(401);
  });
});
