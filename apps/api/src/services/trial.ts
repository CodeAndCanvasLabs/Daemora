/**
 * Trial-state service.
 *
 *  - startTrial(userId)            create a 7-day trial subscription row
 *  - statusFor(userId)              { state, daysLeft, subscription? }
 *  - dueForReminder()               users whose trial ends in N days but
 *                                   we haven't reminded yet
 *  - dueForExpiry()                 users whose trial has ended and
 *                                   subscription hasn't been activated
 *  - expireOne(userId)              mark trial expired; caller suspends
 *                                   tenant via control plane
 */

import { and, eq, isNull, lt } from "drizzle-orm";

import type { DB } from "../db/client.js";
import { subscriptions, users, type Subscription } from "../db/schema.js";

const TRIAL_DAYS = 7;
const MS_PER_DAY = 86_400_000;

export interface TrialStatus {
  readonly state: "none" | "trialing" | "active" | "expired" | "canceled";
  readonly daysLeft: number;        // 0 if not in trial
  readonly subscription?: Subscription;
}

export class TrialService {
  constructor(private readonly db: DB) {}

  /** Create a 7-day trial for a verified user. Idempotent — returns the existing row if any. */
  async startTrial(userId: string): Promise<Subscription> {
    const existing = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1);
    if (existing.length > 0) return existing[0]!;

    const now = new Date();
    const ends = new Date(now.getTime() + TRIAL_DAYS * MS_PER_DAY);
    const inserted = await this.db
      .insert(subscriptions)
      .values({
        userId,
        plan: "trial",
        status: "trialing",
        trialStartsAt: now,
        trialEndsAt: ends,
        externalProvider: "contra",
      })
      .returning();

    await this.db
      .update(users)
      .set({ hadTrial: true, updatedAt: new Date() })
      .where(eq(users.id, userId));

    return inserted[0]!;
  }

  /** Read state for a user. */
  async statusFor(userId: string): Promise<TrialStatus> {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1);
    if (rows.length === 0) return { state: "none", daysLeft: 0 };
    const sub = rows[0]!;
    const state = ((): TrialStatus["state"] => {
      if (sub.status === "trialing") return "trialing";
      if (sub.status === "active") return "active";
      if (sub.status === "canceled") return "canceled";
      if (sub.status === "expired") return "expired";
      return "none";
    })();
    const daysLeft = sub.trialEndsAt
      ? Math.max(0, Math.ceil((sub.trialEndsAt.getTime() - Date.now()) / MS_PER_DAY))
      : 0;
    return { state, daysLeft, subscription: sub };
  }

  /**
   * Trials that ended without a paid plan — caller should suspend
   * the tenant Machine and email the user.
   */
  async dueForExpiry(now = new Date()): Promise<Subscription[]> {
    return this.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.status, "trialing"),
          lt(subscriptions.trialEndsAt, now),
        ),
      );
  }

  /** Mark a trial expired. Idempotent. */
  async expireOne(subscriptionId: string): Promise<void> {
    await this.db
      .update(subscriptions)
      .set({ status: "expired", updatedAt: new Date() })
      .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.status, "trialing")));
  }

  /** Activate the trial as a paid subscription (paid via Contra). */
  async activatePaid(subscriptionId: string, plan: "lite" | "pro", externalId: string): Promise<void> {
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 30 * MS_PER_DAY);
    await this.db
      .update(subscriptions)
      .set({
        status: "active",
        plan,
        externalId,
        currentPeriodStartsAt: now,
        currentPeriodEndsAt: periodEnd,
        updatedAt: now,
      })
      .where(eq(subscriptions.id, subscriptionId));
  }

  /** Trial subscriptions ending in `daysOut` days (0, 1, 2 are the typical reminder cadence). */
  async endingInDays(daysOut: number, now = new Date()): Promise<Subscription[]> {
    const target = new Date(now.getTime() + daysOut * MS_PER_DAY);
    const windowStart = new Date(target.getTime() - 30 * 60 * 1000);  // 30-min window
    const windowEnd = new Date(target.getTime() + 30 * 60 * 1000);
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.status, "trialing"));
    return rows.filter((r) =>
      r.trialEndsAt && r.trialEndsAt >= windowStart && r.trialEndsAt <= windowEnd,
    );
  }
}

export const TRIAL_LENGTH_DAYS = TRIAL_DAYS;
