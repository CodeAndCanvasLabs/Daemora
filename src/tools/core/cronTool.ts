/**
 * cron(action, ...) — schedule and manage cron jobs from inside the agent.
 *
 * Actions mirror the JS tool:
 *   status   — scheduler state (running?, job count, in-flight count)
 *   list     — all configured jobs
 *   add      — create a job (requires `expression` + `task`)
 *   update   — patch an existing job
 *   enable   — re-enable a disabled job
 *   disable  — pause a job without deleting it
 *   remove   — delete a job permanently
 *   run      — trigger a job immediately (out-of-band)
 *   history  — fetch run history for a job
 *
 * The cron expression format is 5-field (min hr dom mon dow) validated
 * by CronStore. Timezone defaults to UTC.
 */

import { z } from "zod";

import type { CronScheduler } from "../../cron/CronScheduler.js";
import type { CronStore } from "../../cron/CronStore.js";
import { NotFoundError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  action: z.enum([
    "status", "list", "add", "update",
    "enable", "disable", "remove", "run", "history",
  ]),
  id: z.string().optional().describe("Job id (required for update/enable/disable/remove/run/history)."),
  name: z.string().optional().describe("Human-readable job name."),
  expression: z.string().optional().describe("5-field cron expression, e.g. '0 9 * * *'."),
  task: z.string().optional().describe("Prompt the agent should run when the job fires."),
  timezone: z.string().optional().describe("IANA zone, e.g. 'America/New_York'. Defaults to UTC."),
  enabled: z.boolean().optional().describe("Enable / disable flag (update action)."),
  delivery: z.record(z.string(), z.unknown()).optional()
    .describe("Delivery routing config (channel metadata, etc.)."),
  limit: z.number().int().min(1).max(200).optional()
    .describe("Max rows for `history` action (default 20)."),
});

export function makeCronTool(store: CronStore, scheduler: CronScheduler): ToolDef<typeof inputSchema, unknown> {
  return {
    name: "cron",
    description:
      "Manage scheduled tasks. Actions: status, list, add, update, enable, disable, remove, run, history.",
    category: "agent",
    source: { kind: "core" },
    tags: ["cron", "schedule", "background"],
    inputSchema,
    async execute(input, { logger }) {
      switch (input.action) {
        case "status": {
          const jobs = store.listJobs();
          const enabled = jobs.filter((j) => j.enabled).length;
          return {
            running: scheduler.isRunning,
            inflight: scheduler.inflightCount,
            jobCount: jobs.length,
            enabledCount: enabled,
            disabledCount: jobs.length - enabled,
          };
        }

        case "list": {
          const jobs = store.listJobs();
          return jobs.map((j) => ({
            id: j.id,
            name: j.name,
            expression: j.expression,
            timezone: j.timezone,
            enabled: j.enabled,
            nextRunAt: j.nextRunAt ? new Date(j.nextRunAt).toISOString() : null,
            lastRunAt: j.lastRunAt ? new Date(j.lastRunAt).toISOString() : null,
          }));
        }

        case "add": {
          if (!input.name) throw new ValidationError("name is required for add");
          if (!input.expression) throw new ValidationError("expression is required for add");
          if (!input.task) throw new ValidationError("task is required for add");
          const job = store.addJob({
            name: input.name,
            expression: input.expression,
            task: input.task,
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            ...(input.timezone ? { timezone: input.timezone } : {}),
            ...(input.delivery ? { delivery: input.delivery } : {}),
          });
          logger.info("cron job created", { id: job.id, name: job.name });
          return {
            id: job.id,
            name: job.name,
            expression: job.expression,
            timezone: job.timezone,
            nextRunAt: job.nextRunAt ? new Date(job.nextRunAt).toISOString() : null,
            message: `Job '${job.name}' created (${job.id.slice(0, 8)})`,
          };
        }

        case "update": {
          if (!input.id) throw new ValidationError("id is required for update");
          const updates: Parameters<CronStore["updateJob"]>[1] = {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.expression !== undefined ? { expression: input.expression } : {}),
            ...(input.task !== undefined ? { task: input.task } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
            ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
          };
          const job = store.updateJob(input.id, updates);
          return {
            id: job.id,
            name: job.name,
            message: `Job '${job.name}' updated`,
            nextRunAt: job.nextRunAt ? new Date(job.nextRunAt).toISOString() : null,
          };
        }

        case "enable":
        case "disable": {
          if (!input.id) throw new ValidationError("id is required");
          const job = store.updateJob(input.id, { enabled: input.action === "enable" });
          return {
            id: job.id,
            enabled: job.enabled,
            message: `Job '${job.name}' ${job.enabled ? "enabled" : "disabled"}`,
            ...(job.enabled && job.nextRunAt ? { nextRunAt: new Date(job.nextRunAt).toISOString() } : {}),
          };
        }

        case "remove": {
          if (!input.id) throw new ValidationError("id is required");
          const ok = store.deleteJob(input.id);
          if (!ok) throw new NotFoundError(`Cron job not found: ${input.id}`);
          return { id: input.id, removed: true, message: `Job ${input.id.slice(0, 8)} removed` };
        }

        case "run": {
          if (!input.id) throw new ValidationError("id is required");
          // Fire-and-forget — errors get logged to the runs table by the
          // scheduler, and we return immediately so the agent can keep
          // working instead of stalling on a potentially long job.
          scheduler.forceRun(input.id).catch((err) => {
            logger.warn("cron force-run failed", { id: input.id, error: (err as Error).message });
          });
          return { id: input.id, triggered: true, message: `Job ${input.id.slice(0, 8)} triggered — check history for results` };
        }

        case "history": {
          if (!input.id) throw new ValidationError("id is required");
          const runs = store.getJobRuns(input.id, input.limit ?? 20);
          return runs.map((r) => ({
            id: r.id,
            status: r.status,
            startedAt: new Date(r.startedAt).toISOString(),
            completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
            durationMs: r.completedAt ? r.completedAt - r.startedAt : null,
            result: r.result,
            error: r.error,
          }));
        }
      }
    },
  };
}
