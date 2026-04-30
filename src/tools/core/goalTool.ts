/**
 * goal(action, ...) — manage persistent autonomous goals.
 *
 * Goals are high-level objectives the agent works toward on a recurring
 * schedule. Actions match the JS tool's API:
 *
 *   create   — new goal with optional cron schedule
 *   list     — all goals (optionally filtered by status)
 *   get      — single goal detail
 *   update   — patch title / description / schedule / progress / notes
 *   delete   — permanent removal
 *   pause    — status = paused (no autonomous checks)
 *   resume   — status = active again
 *   complete — status = completed
 *   check    — mark for immediate re-check on next pulse tick
 */

import { z } from "zod";

import type { GoalStore } from "../../goals/GoalStore.js";
import { NotFoundError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  action: z.enum([
    "create", "list", "get", "update", "delete",
    "pause", "resume", "complete", "check",
  ]),
  id: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  checkCron: z.string().optional().describe("Cron expression for autonomous re-check (default every 4h)."),
  progress: z.number().int().min(0).max(100).optional().describe("Completion percentage 0-100."),
  notes: z.string().optional(),
  status: z.enum(["active", "completed", "paused", "failed"]).optional().describe("Filter for list action."),
});

const DEFAULT_CHECK_CRON = "0 */4 * * *";

export function makeGoalTool(store: GoalStore): ToolDef<typeof inputSchema, unknown> {
  return {
    name: "goal",
    description:
      "Manage persistent autonomous goals. Actions: create, list, get, update, delete, pause, resume, complete, check.",
    category: "agent",
    source: { kind: "core" },
    tags: ["goal", "autonomous", "planning"],
    inputSchema,
    async execute(input, { logger }) {
      switch (input.action) {
        case "create": {
          if (!input.title) throw new ValidationError("title is required");
          const goal = store.create({
            title: input.title,
            ...(input.description ? { description: input.description } : {}),
            checkCron: input.checkCron ?? DEFAULT_CHECK_CRON,
          });
          if (input.progress !== undefined || input.notes !== undefined) {
            store.update(goal.id, {
              ...(input.progress !== undefined ? { progress: input.progress } : {}),
              ...(input.notes !== undefined ? { notes: input.notes } : {}),
            });
          }
          logger.info("goal created", { id: goal.id, title: goal.title });
          return {
            id: goal.id,
            title: goal.title,
            status: goal.status,
            checkCron: goal.checkCron,
            message: `Goal '${goal.title}' created (${goal.id.slice(0, 8)})`,
          };
        }

        case "list": {
          const all = store.list();
          const filtered = input.status ? all.filter((g) => g.status === input.status) : all;
          return filtered.map((g) => ({
            id: g.id,
            title: g.title,
            status: g.status,
            checkCron: g.checkCron,
            progress: g.progress,
            lastCheckedAt: g.lastCheckedAt ? new Date(g.lastCheckedAt).toISOString() : null,
            completedAt: g.completedAt ? new Date(g.completedAt).toISOString() : null,
          }));
        }

        case "get": {
          if (!input.id) throw new ValidationError("id is required");
          const goal = store.get(input.id);
          if (!goal) throw new NotFoundError(`Goal not found: ${input.id}`);
          return {
            ...goal,
            lastCheckedAt: goal.lastCheckedAt ? new Date(goal.lastCheckedAt).toISOString() : null,
            completedAt: goal.completedAt ? new Date(goal.completedAt).toISOString() : null,
            createdAt: new Date(goal.createdAt).toISOString(),
            updatedAt: new Date(goal.updatedAt).toISOString(),
          };
        }

        case "update": {
          if (!input.id) throw new ValidationError("id is required");
          const patch: Parameters<GoalStore["update"]>[1] = {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.checkCron !== undefined ? { checkCron: input.checkCron } : {}),
            ...(input.progress !== undefined ? { progress: input.progress } : {}),
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
          };
          const ok = store.update(input.id, patch);
          if (!ok) throw new NotFoundError(`Goal not found: ${input.id}`);
          return { id: input.id, updated: true, message: `Goal ${input.id.slice(0, 8)} updated` };
        }

        case "delete": {
          if (!input.id) throw new ValidationError("id is required");
          const ok = store.delete(input.id);
          if (!ok) throw new NotFoundError(`Goal not found: ${input.id}`);
          return { id: input.id, removed: true, message: `Goal ${input.id.slice(0, 8)} removed` };
        }

        case "pause":
        case "resume":
        case "complete": {
          if (!input.id) throw new ValidationError("id is required");
          const nextStatus = input.action === "pause"
            ? "paused"
            : input.action === "resume"
              ? "active"
              : "completed";
          const ok = store.update(input.id, { status: nextStatus });
          if (!ok) throw new NotFoundError(`Goal not found: ${input.id}`);
          return { id: input.id, status: nextStatus, message: `Goal ${input.id.slice(0, 8)} → ${nextStatus}` };
        }

        case "check": {
          if (!input.id) throw new ValidationError("id is required");
          // Mark the goal as "checked just now" — the next pulse tick
          // treats stale lastCheckedAt as the "is it due?" signal, so
          // nudging it here queues the goal for the next autonomous pass.
          const existing = store.get(input.id);
          if (!existing) throw new NotFoundError(`Goal not found: ${input.id}`);
          // Re-save with status=active to un-pause if paused, and mark
          // checked-now so the scheduler's "due" logic picks it up on
          // the next tick.
          store.update(input.id, { status: "active" }, true);
          return { id: input.id, message: `Goal ${input.id.slice(0, 8)} queued for immediate re-check` };
        }
      }
    },
  };
}
