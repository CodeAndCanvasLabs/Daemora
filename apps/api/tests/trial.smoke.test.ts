/**
 * Phase 11 — Trial service tests.
 *
 *   - startTrial creates a trialing subscription with 7-day window
 *   - statusFor reports trialing / expired / active correctly
 *   - dueForExpiry returns subs whose trialEndsAt is in the past
 *   - expireOne is idempotent and only touches trialing rows
 *   - activatePaid flips trial → active with billing fields populated
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { TrialService } from "../src/services/trial.js";
import { users, subscriptions } from "../src/db/schema.js";
import { makeTestDb } from "./helpers.js";
import type { DB } from "../src/db/client.js";

let db: DB;
let trial: TrialService;

async function seedUser(email = "alice@daemora.com"): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({ id, email, emailVerified: true, emailVerifiedAt: new Date() });
  return id;
}

beforeEach(() => {
  const ctx = makeTestDb();
  db = ctx.db;
  trial = new TrialService(db);
});

describe("TrialService.startTrial", () => {
  it("creates a trialing subscription with a 7-day end date", async () => {
    const userId = await seedUser();
    const sub = await trial.startTrial(userId);

    expect(sub.plan).toBe("trial");
    expect(sub.status).toBe("trialing");
    expect(sub.trialEndsAt).toBeTruthy();
    const days = (sub.trialEndsAt!.getTime() - sub.trialStartsAt!.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(7, 0);
  });

  it("is idempotent — second call returns the same row", async () => {
    const userId = await seedUser();
    const a = await trial.startTrial(userId);
    const b = await trial.startTrial(userId);
    expect(a.id).toBe(b.id);
  });

  it("sets hadTrial=true on the user", async () => {
    const userId = await seedUser();
    await trial.startTrial(userId);
    const u = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    expect(u[0]?.hadTrial).toBe(true);
  });
});

describe("TrialService.statusFor", () => {
  it("returns 'none' for a user with no subscription", async () => {
    const userId = await seedUser();
    expect((await trial.statusFor(userId)).state).toBe("none");
  });

  it("returns 'trialing' with daysLeft > 0 inside the window", async () => {
    const userId = await seedUser();
    await trial.startTrial(userId);
    const status = await trial.statusFor(userId);
    expect(status.state).toBe("trialing");
    expect(status.daysLeft).toBeGreaterThan(0);
    expect(status.daysLeft).toBeLessThanOrEqual(7);
  });

  it("flips to 'expired' once the trial end has passed and expireOne is called", async () => {
    const userId = await seedUser();
    const sub = await trial.startTrial(userId);
    // Force trial end into the past.
    await db
      .update(subscriptions)
      .set({ trialEndsAt: new Date(Date.now() - 60_000) })
      .where(eq(subscriptions.id, sub.id));

    const due = await trial.dueForExpiry();
    expect(due.length).toBe(1);
    await trial.expireOne(due[0]!.id);

    const status = await trial.statusFor(userId);
    expect(status.state).toBe("expired");
    expect(status.daysLeft).toBe(0);
  });
});

describe("TrialService.activatePaid", () => {
  it("flips trial → active with plan + externalId set", async () => {
    const userId = await seedUser();
    const sub = await trial.startTrial(userId);
    await trial.activatePaid(sub.id, "pro", "contra-tx-abc");
    const status = await trial.statusFor(userId);
    expect(status.state).toBe("active");
    expect(status.subscription?.plan).toBe("pro");
    expect(status.subscription?.externalId).toBe("contra-tx-abc");
    expect(status.subscription?.currentPeriodEndsAt).toBeTruthy();
  });
});

describe("TrialService.dueForExpiry", () => {
  it("returns only trialing rows past their end", async () => {
    const a = await seedUser("a@x.com");
    const b = await seedUser("b@x.com");
    const c = await seedUser("c@x.com");

    const subA = await trial.startTrial(a);
    await trial.startTrial(b);                  // still in trial
    const subC = await trial.startTrial(c);

    // a: expired (past end); c: also past but already active
    await db.update(subscriptions).set({ trialEndsAt: new Date(Date.now() - 60_000) }).where(eq(subscriptions.id, subA.id));
    await db.update(subscriptions).set({
      trialEndsAt: new Date(Date.now() - 60_000),
      status: "active",
    }).where(eq(subscriptions.id, subC.id));

    const due = await trial.dueForExpiry();
    expect(due.map((s) => s.userId).sort()).toEqual([a].sort());
  });
});

describe("TrialService.expireOne", () => {
  it("only flips rows still in 'trialing' (idempotent)", async () => {
    const userId = await seedUser();
    const sub = await trial.startTrial(userId);
    await trial.expireOne(sub.id);
    await trial.expireOne(sub.id);          // second call is a no-op
    const status = await trial.statusFor(userId);
    expect(status.state).toBe("expired");
  });

  it("doesn't downgrade an already-active subscription to expired", async () => {
    const userId = await seedUser();
    const sub = await trial.startTrial(userId);
    await trial.activatePaid(sub.id, "lite", "contra-1");
    await trial.expireOne(sub.id);
    const status = await trial.statusFor(userId);
    expect(status.state).toBe("active");
  });
});
