/**
 * MorningPulse — create a default daily briefing cron job per tenant.
 * Uses existing Scheduler infrastructure. No new backend needed.
 */
import scheduler from "./Scheduler.js";

const PULSE_NAME = "Morning Pulse";
const DEFAULT_CRON = "0 8 * * *";
const DEFAULT_TASK = [
  "Morning briefing. Summarize:",
  "- Pending tasks and goals needing attention",
  "- Overnight activity (check daily log)",
  "- Upcoming scheduled jobs",
  "- Any failed tasks or alerts",
  "Be concise. Prioritize actionable items.",
].join("\n");

/**
 * Create a Morning Pulse cron job for a tenant (if one doesn't exist).
 * @param {string} tenantId
 * @param {string} [timezone] — IANA timezone (default: UTC)
 * @param {object} [delivery] — { mode, channel, channelMeta }
 * @returns {object} created or existing job
 */
export function createMorningPulse(tenantId, timezone, delivery) {
  const existing = scheduler.list(tenantId).find(j => j.name === PULSE_NAME);
  if (existing) return { job: existing, created: false };

  const job = scheduler.create({
    name: PULSE_NAME,
    tenantId,
    schedule: { kind: "cron", expr: DEFAULT_CRON, tz: timezone || null },
    taskInput: DEFAULT_TASK,
    delivery: delivery || { mode: "none" },
    description: "Daily morning briefing — summarizes your day ahead.",
  });

  console.log(`[MorningPulse] Created for tenant ${tenantId} at ${DEFAULT_CRON}${timezone ? ` (${timezone})` : ""}`);
  return { job, created: true };
}

/**
 * Remove the Morning Pulse cron job for a tenant.
 */
export function removeMorningPulse(tenantId) {
  const existing = scheduler.list(tenantId).find(j => j.name === PULSE_NAME);
  if (!existing) return false;
  scheduler.delete(existing.id, tenantId);
  return true;
}
