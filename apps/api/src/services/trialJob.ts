/**
 * Trial automation job — runs on a timer (cron in prod, manual in
 * tests). Responsibilities:
 *
 *  1. Send "2 days left" reminder email to users whose trial ends in 2d.
 *  2. Send "1 day left" reminder email.
 *  3. Send "ends today" reminder.
 *  4. Expire trials whose end has passed AND suspend their tenant
 *     Machine via control plane.
 *
 * Idempotent — running it many times in a row is fine. State is
 * the subscriptions table; we don't keep separate "did we email yet"
 * flags because the windowing (30-min around the target) is tight
 * enough that the cron only catches each user once.
 */

import { and, eq } from "drizzle-orm";

import type { DB } from "../db/client.js";
import { subscriptions, tenants, users } from "../db/schema.js";
import type { TenantProvisioner } from "./provision.js";
import type { EmailSender } from "./email.js";
import { sendTrialReminderEmail } from "./email.js";
import { TrialService } from "./trial.js";

export interface TrialJobOpts {
  readonly db: DB;
  readonly trial: TrialService;
  readonly email: EmailSender;
  readonly controlPlane: TenantProvisioner;
  readonly subscribeUrl: string;          // e.g. https://daemora.com/subscribe
}

export interface TrialJobResult {
  readonly remindersSent: number;
  readonly expired: number;
  readonly suspendErrors: number;
}

export async function runTrialJob(opts: TrialJobOpts): Promise<TrialJobResult> {
  const result = { remindersSent: 0, expired: 0, suspendErrors: 0 };

  // 1-3. Reminders at 2d / 1d / 0d.
  for (const days of [2, 1, 0]) {
    const dueSubs = await opts.trial.endingInDays(days);
    for (const sub of dueSubs) {
      const userRow = await opts.db.select().from(users).where(eq(users.id, sub.userId)).limit(1).then((r) => r[0]);
      if (!userRow) continue;
      await sendTrialReminderEmail(opts.email, {
        to: userRow.email,
        daysLeft: days,
        subscribeUrl: opts.subscribeUrl,
      });
      result.remindersSent++;
    }
  }

  // 4. Expire + suspend.
  const expired = await opts.trial.dueForExpiry();
  for (const sub of expired) {
    await opts.trial.expireOne(sub.id);
    result.expired++;

    // Suspend the tenant Machine via control plane.
    const tenantRow = await opts.db
      .select()
      .from(tenants)
      .where(eq(tenants.userId, sub.userId))
      .limit(1)
      .then((r) => r[0]);
    if (!tenantRow) continue;
    try {
      await opts.controlPlane.suspend(tenantRow.slug, "trial_expired");
      await opts.db
        .update(tenants)
        .set({ status: "suspended" })
        .where(eq(tenants.id, tenantRow.id));
    } catch {
      result.suspendErrors++;
    }
  }

  return result;
}
