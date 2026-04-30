/**
 * watcher(action, ...) — manage event-driven triggers.
 *
 * Watchers fire when a condition is met (webhook received, poll result
 * changes, file modified, cron tick). This tool configures them; the
 * runtime execution is handled by the server-side WatcherRunner.
 *
 * Actions:
 *   create  — new watcher
 *   list    — all watchers
 *   get     — details for one watcher
 *   update  — patch fields
 *   delete  — permanent removal
 *   enable  — turn on
 *   disable — turn off without deleting
 */

import { z } from "zod";

import type { WatcherStore } from "../../watchers/WatcherStore.js";
import { NotFoundError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const TRIGGER_TYPES = ["webhook", "poll", "file", "cron"] as const;

const inputSchema = z.object({
  action: z.enum(["create", "list", "get", "update", "delete", "enable", "disable"]),
  id: z.string().optional(),
  name: z.string().optional(),
  triggerType: z.enum(TRIGGER_TYPES).optional().describe("Source type."),
  pattern: z.string().optional().describe("Trigger-specific matcher: URL path for webhook, path glob for file, cron expr, etc."),
  actionSpec: z.string().optional().describe("What the agent does when fired — usually a prompt or task id."),
  channel: z.string().optional().describe("Delivery channel for the resulting agent reply."),
});

export function makeWatcherTool(store: WatcherStore): ToolDef<typeof inputSchema, unknown> {
  return {
    name: "watcher",
    description:
      "Manage event-driven triggers (webhooks, polls, file watches, cron). Actions: create, list, get, update, delete, enable, disable.",
    category: "agent",
    source: { kind: "core" },
    tags: ["watcher", "trigger", "event", "webhook"],
    inputSchema,
    async execute(input, { logger }) {
      switch (input.action) {
        case "create": {
          if (!input.name) throw new ValidationError("name is required");
          const watcher = store.create({
            name: input.name,
            ...(input.triggerType ? { triggerType: input.triggerType } : {}),
            ...(input.pattern !== undefined ? { pattern: input.pattern } : {}),
            ...(input.actionSpec !== undefined ? { action: input.actionSpec } : {}),
            ...(input.channel ? { channel: input.channel } : {}),
          });
          logger.info("watcher created", { id: watcher.id, name: watcher.name, triggerType: watcher.triggerType });
          return {
            id: watcher.id,
            name: watcher.name,
            triggerType: watcher.triggerType,
            enabled: watcher.enabled,
            message: `Watcher '${watcher.name}' (${watcher.triggerType}) created (${watcher.id.slice(0, 8)})`,
          };
        }

        case "list": {
          return store.list().map((w) => ({
            id: w.id,
            name: w.name,
            triggerType: w.triggerType,
            pattern: w.pattern,
            channel: w.channel,
            enabled: w.enabled,
            triggerCount: w.triggerCount,
            lastTriggeredAt: w.lastTriggeredAt ? new Date(w.lastTriggeredAt).toISOString() : null,
          }));
        }

        case "get": {
          if (!input.id) throw new ValidationError("id is required");
          const w = store.get(input.id);
          if (!w) throw new NotFoundError(`Watcher not found: ${input.id}`);
          return {
            ...w,
            lastTriggeredAt: w.lastTriggeredAt ? new Date(w.lastTriggeredAt).toISOString() : null,
            createdAt: new Date(w.createdAt).toISOString(),
            updatedAt: new Date(w.updatedAt).toISOString(),
          };
        }

        case "update": {
          if (!input.id) throw new ValidationError("id is required");
          const patch: Parameters<WatcherStore["update"]>[1] = {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.triggerType !== undefined ? { triggerType: input.triggerType } : {}),
            ...(input.pattern !== undefined ? { pattern: input.pattern } : {}),
            ...(input.actionSpec !== undefined ? { action: input.actionSpec } : {}),
            ...(input.channel !== undefined ? { channel: input.channel } : {}),
          };
          const ok = store.update(input.id, patch);
          if (!ok) throw new NotFoundError(`Watcher not found: ${input.id}`);
          return { id: input.id, updated: true, message: `Watcher ${input.id.slice(0, 8)} updated` };
        }

        case "delete": {
          if (!input.id) throw new ValidationError("id is required");
          const ok = store.delete(input.id);
          if (!ok) throw new NotFoundError(`Watcher not found: ${input.id}`);
          return { id: input.id, removed: true, message: `Watcher ${input.id.slice(0, 8)} removed` };
        }

        case "enable":
        case "disable": {
          if (!input.id) throw new ValidationError("id is required");
          const ok = store.update(input.id, { enabled: input.action === "enable" });
          if (!ok) throw new NotFoundError(`Watcher not found: ${input.id}`);
          return { id: input.id, enabled: input.action === "enable", message: `Watcher ${input.id.slice(0, 8)} ${input.action}d` };
        }
      }
    },
  };
}
