/**
 * Phase 11 — Trial cron tests.
 *
 *  - reminders fire at 2d / 1d / 0d windows
 *  - expired trials are flipped and the tenant Machine is suspended
 *  - suspend errors are counted but don't abort the run
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { runTrialJob } from "../src/services/trialJob.js";
import { TrialService } from "../src/services/trial.js";
import { InMemorySender } from "../src/services/email.js";
import { ControlPlaneClient } from "../src/services/controlPlaneClient.js";
import { subscriptions, tenants, users } from "../src/db/schema.js";
import { makeTestDb } from "./helpers.js";
import type { DB } from "../src/db/client.js";

let db: DB;
let trial: TrialService;
let email: InMemorySender;

interface FakeFetchCall {
  url: string;
  method: string;
  body: string | undefined;
}

function fakeFetch(opts: { fail?: boolean } = {}): { fetch: typeof fetch; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  const f: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (opts.fail) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: f, calls };
}

async function seedUserWithTenant(emailAddr: string): Promise<{ userId: string; slug: string }> {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, email: emailAddr, emailVerified: true });
  const slug = `tenant-${userId.slice(0, 8)}`;
  await db.insert(tenants).values({ userId, slug, status: "running" });
  return { userId, slug };
}

beforeEach(() => {
  const ctx = makeTestDb();
  db = ctx.db;
  trial = new TrialService(db);
  email = new InMemorySender();
});

describe("runTrialJob — reminders", () => {
  it("sends a reminder for trials ending in 0 / 1 / 2 days", async () => {
    const { userId: u0 } = await seedUserWithTenant("today@x.com");
    const { userId: u1 } = await seedUserWithTenant("tomorrow@x.com");
    const { userId: u2 } = await seedUserWithTenant("twodays@x.com");
    const { userId: u5 } = await seedUserWithTenant("notdue@x.com");

    const sub0 = await trial.startTrial(u0);
    const sub1 = await trial.startTrial(u1);
    const sub2 = await trial.startTrial(u2);
    await trial.startTrial(u5);                              // default 7-day window — not due

    const now = Date.now();
    await db.update(subscriptions).set({ trialEndsAt: new Date(now) }).where(eq(subscriptions.id, sub0.id));
    await db.update(subscriptions).set({ trialEndsAt: new Date(now + 86_400_000) }).where(eq(subscriptions.id, sub1.id));
    await db.update(subscriptions).set({ trialEndsAt: new Date(now + 2 * 86_400_000) }).where(eq(subscriptions.id, sub2.id));

    const { fetch: ff } = fakeFetch();
    const cp = new ControlPlaneClient({ baseUrl: "http://cp.local", adminToken: "t", fetch: ff });

    const r = await runTrialJob({ db, trial, email, controlPlane: cp, subscribeUrl: "https://daemora.com/subscribe" });

    expect(r.remindersSent).toBe(3);
    expect(email.sent.map((e) => e.to).sort()).toEqual(
      ["today@x.com", "tomorrow@x.com", "twodays@x.com"].sort(),
    );
    for (const sent of email.sent) {
      expect(sent.tag).toBe("trial_reminder");
    }
  });

  it("does not send reminders for already-active subscriptions", async () => {
    const { userId } = await seedUserWithTenant("paid@x.com");
    const sub = await trial.startTrial(userId);
    await trial.activatePaid(sub.id, "pro", "contra-1");

    // Force trialEndsAt to "today" — but the row is no longer trialing.
    await db.update(subscriptions).set({ trialEndsAt: new Date() }).where(eq(subscriptions.id, sub.id));

    const { fetch: ff } = fakeFetch();
    const cp = new ControlPlaneClient({ baseUrl: "http://cp.local", adminToken: "t", fetch: ff });
    const r = await runTrialJob({ db, trial, email, controlPlane: cp, subscribeUrl: "https://daemora.com/subscribe" });

    expect(r.remindersSent).toBe(0);
    expect(email.sent).toHaveLength(0);
  });
});

describe("runTrialJob — expiry + suspend", () => {
  it("expires past-due trials and suspends the tenant Machine", async () => {
    const { userId, slug } = await seedUserWithTenant("expired@x.com");
    const sub = await trial.startTrial(userId);

    // Push trial end into the past so it's due for expiry.
    await db
      .update(subscriptions)
      .set({ trialEndsAt: new Date(Date.now() - 60_000) })
      .where(eq(subscriptions.id, sub.id));

    const { fetch: ff, calls } = fakeFetch();
    const cp = new ControlPlaneClient({ baseUrl: "http://cp.local", adminToken: "admin-tok", fetch: ff });

    const r = await runTrialJob({ db, trial, email, controlPlane: cp, subscribeUrl: "https://daemora.com/subscribe" });

    expect(r.expired).toBe(1);
    expect(r.suspendErrors).toBe(0);

    // Control plane suspend was called with the tenant slug + reason.
    const suspendCall = calls.find((c) => c.url.includes(`/admin/tenants/${slug}/suspend`));
    expect(suspendCall).toBeDefined();
    expect(suspendCall!.method).toBe("POST");
    expect(suspendCall!.body).toContain("trial_expired");

    // DB rows updated.
    const updatedSub = await db.select().from(subscriptions).where(eq(subscriptions.id, sub.id)).limit(1);
    expect(updatedSub[0]?.status).toBe("expired");
    const updatedTenant = await db.select().from(tenants).where(eq(tenants.userId, userId)).limit(1);
    expect(updatedTenant[0]?.status).toBe("suspended");
  });

  it("counts suspend errors but does not abort the run", async () => {
    const { userId: a } = await seedUserWithTenant("a@x.com");
    const { userId: b } = await seedUserWithTenant("b@x.com");

    const subA = await trial.startTrial(a);
    const subB = await trial.startTrial(b);

    await db.update(subscriptions).set({ trialEndsAt: new Date(Date.now() - 60_000) }).where(eq(subscriptions.id, subA.id));
    await db.update(subscriptions).set({ trialEndsAt: new Date(Date.now() - 60_000) }).where(eq(subscriptions.id, subB.id));

    const { fetch: ff } = fakeFetch({ fail: true });
    const cp = new ControlPlaneClient({ baseUrl: "http://cp.local", adminToken: "t", fetch: ff });

    const r = await runTrialJob({ db, trial, email, controlPlane: cp, subscribeUrl: "https://daemora.com/subscribe" });

    expect(r.expired).toBe(2);
    expect(r.suspendErrors).toBe(2);

    // Subscriptions are still expired — only the suspend call to control plane failed.
    const rowA = await db.select().from(subscriptions).where(eq(subscriptions.id, subA.id)).limit(1);
    const rowB = await db.select().from(subscriptions).where(eq(subscriptions.id, subB.id)).limit(1);
    expect(rowA[0]?.status).toBe("expired");
    expect(rowB[0]?.status).toBe("expired");
  });

  it("skips suspend when no tenant row exists for the user", async () => {
    const userId = randomUUID();
    await db.insert(users).values({ id: userId, email: "no-tenant@x.com", emailVerified: true });
    const sub = await trial.startTrial(userId);
    await db.update(subscriptions).set({ trialEndsAt: new Date(Date.now() - 60_000) }).where(eq(subscriptions.id, sub.id));

    const { fetch: ff, calls } = fakeFetch();
    const cp = new ControlPlaneClient({ baseUrl: "http://cp.local", adminToken: "t", fetch: ff });

    const r = await runTrialJob({ db, trial, email, controlPlane: cp, subscribeUrl: "https://daemora.com/subscribe" });

    expect(r.expired).toBe(1);
    expect(r.suspendErrors).toBe(0);
    expect(calls.find((c) => c.url.includes("/suspend"))).toBeUndefined();
  });
});

describe("runTrialJob — idempotency", () => {
  it("running twice does not double-expire or re-suspend", async () => {
    const { userId } = await seedUserWithTenant("idem@x.com");
    const sub = await trial.startTrial(userId);
    await db.update(subscriptions).set({ trialEndsAt: new Date(Date.now() - 60_000) }).where(eq(subscriptions.id, sub.id));

    const { fetch: ff, calls } = fakeFetch();
    const cp = new ControlPlaneClient({ baseUrl: "http://cp.local", adminToken: "t", fetch: ff });

    const first = await runTrialJob({ db, trial, email, controlPlane: cp, subscribeUrl: "https://daemora.com/subscribe" });
    expect(first.expired).toBe(1);

    const second = await runTrialJob({ db, trial, email, controlPlane: cp, subscribeUrl: "https://daemora.com/subscribe" });
    expect(second.expired).toBe(0);                          // no longer trialing → not in dueForExpiry()
    expect(calls.filter((c) => c.url.includes("/suspend"))).toHaveLength(1);
  });
});
