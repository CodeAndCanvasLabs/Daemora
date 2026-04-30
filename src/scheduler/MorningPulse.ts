/**
 * MorningPulse — ensure a daily briefing cron job is present.
 *
 * Idempotent: running this at startup either finds the existing job or
 * creates it with the default expression + task prompt. All actual
 * execution goes through the normal cron scheduler + CronExecutor.
 */

import type { CronJob, CronStore } from "../cron/CronStore.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("morning-pulse");

export const MORNING_PULSE_NAME = "Morning Pulse";
const DEFAULT_EXPRESSION = "0 8 * * *";
const DEFAULT_TASK = [
  "Morning briefing. Summarise:",
  "- Pending tasks and goals: use the goal/task tools to list active goals and recent/failed tasks.",
  "- Overnight activity: if ./data/daily.log exists, read it; otherwise skip.",
  "- Upcoming scheduled jobs: use the cron tool to list enabled jobs and their next-run times.",
  "- Any failed tasks or alerts: check recent task failures and audit events.",
  "",
  "Be concise. Prioritise actionable items. Never guess or invent files — if a source doesn't exist, say so in one line and move on.",
].join("\n");

export interface MorningPulseOptions {
  readonly timezone?: string;
  readonly delivery?: Record<string, unknown>;
}

/**
 * Create the Morning Pulse cron job if it doesn't exist.
 * Returns the existing or newly created job plus a `created` flag.
 */
export function ensureMorningPulse(store: CronStore, opts: MorningPulseOptions = {}): { job: CronJob; created: boolean } {
  const existing = store.listJobs().find((j) => j.name === MORNING_PULSE_NAME);
  if (existing) return { job: existing, created: false };

  const job = store.addJob({
    name: MORNING_PULSE_NAME,
    expression: DEFAULT_EXPRESSION,
    task: DEFAULT_TASK,
    ...(opts.timezone ? { timezone: opts.timezone } : {}),
    ...(opts.delivery ? { delivery: opts.delivery } : {}),
  });
  log.info({ id: job.id, expression: DEFAULT_EXPRESSION, tz: job.timezone }, "morning pulse created");
  return { job, created: true };
}

export function removeMorningPulse(store: CronStore): boolean {
  const existing = store.listJobs().find((j) => j.name === MORNING_PULSE_NAME);
  if (!existing) return false;
  return store.deleteJob(existing.id);
}
