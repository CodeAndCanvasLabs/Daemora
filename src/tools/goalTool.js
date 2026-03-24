/**
 * goal(action, ...) - Manage persistent autonomous goals.
 *
 * Actions:
 *   create   - create a new goal
 *   list     - list goals for current tenant
 *   update   - patch an existing goal
 *   delete   - remove a goal
 *   pause    - pause a goal
 *   resume   - resume a paused goal
 *   check    - force-check now (enqueue immediately)
 *   complete - mark goal as completed
 */
import { randomUUID } from "crypto";
import { Cron } from "croner";
import { saveGoal, loadGoal, loadGoalsByTenant, deleteGoal as removeGoal } from "../storage/GoalStore.js";
import tenantContext from "../tenants/TenantContext.js";

function _getTenantId() {
  return tenantContext.getStore()?.tenant?.id || null;
}

function _getChannelMeta() {
  return tenantContext.getStore()?.channelMeta || null;
}

function _computeNextCheckAt(cronExpr, tz) {
  const expr = cronExpr || "0 */4 * * *";
  const cronInstance = new Cron(expr, { timezone: tz || undefined });
  const next = cronInstance.nextRun();
  return next ? next.toISOString() : null;
}

export function goal(toolParams) {
  const action = toolParams?.action;
  try {
    const { action: _discard, ...params } = toolParams || {};
    const tenantId = _getTenantId();

    switch (action) {
      case "create": {
        if (!params.title) return "Error: title is required.";
        const id = randomUUID().slice(0, 8);
        const now = new Date().toISOString();

        // Auto-set delivery from current channel
        let delivery = null;
        const channelMeta = _getChannelMeta();
        if (channelMeta) {
          delivery = { channel: channelMeta.channel, channelMeta };
        }

        const goalObj = {
          id,
          tenantId,
          title: params.title,
          description: params.description || null,
          strategy: params.strategy || null,
          status: "active",
          priority: params.priority ?? 5,
          checkCron: params.checkCron || "0 */4 * * *",
          checkTz: params.checkTz || null,
          lastCheckAt: null,
          lastResult: null,
          nextCheckAt: _computeNextCheckAt(params.checkCron, params.checkTz),
          consecutiveFailures: 0,
          maxFailures: params.maxFailures ?? 3,
          delivery,
          createdAt: now,
          updatedAt: now,
        };

        saveGoal(goalObj);
        return `Goal created: "${goalObj.title}" | priority: ${goalObj.priority} | schedule: ${goalObj.checkCron} | ID: ${id} | next: ${goalObj.nextCheckAt || "computing..."}`;
      }

      case "list": {
        const goals = loadGoalsByTenant(tenantId);
        if (goals.length === 0) return "No goals configured.";
        return goals.map(g => {
          const delivery = g.delivery?.channel ? ` → ${g.delivery.channel}` : "";
          return `• ${g.id} "${g.title}" | ${g.status} | priority: ${g.priority} | schedule: ${g.checkCron} | failures: ${g.consecutiveFailures}/${g.maxFailures} | next: ${g.nextCheckAt || "n/a"}${delivery}`;
        }).join("\n");
      }

      case "update": {
        if (!params.id) return 'Error: id is required. Use goal("list") to see goal IDs.';
        const existing = loadGoal(params.id);
        if (!existing) return `Error: goal ${params.id} not found.`;
        if (existing.tenantId !== tenantId) return "Error: goal belongs to a different tenant.";

        if (params.title !== undefined) existing.title = params.title;
        if (params.description !== undefined) existing.description = params.description;
        if (params.strategy !== undefined) existing.strategy = params.strategy;
        if (params.priority !== undefined) existing.priority = params.priority;
        if (params.maxFailures !== undefined) existing.maxFailures = params.maxFailures;
        if (params.checkCron !== undefined) {
          existing.checkCron = params.checkCron;
          existing.nextCheckAt = _computeNextCheckAt(params.checkCron, params.checkTz || existing.checkTz);
        }
        if (params.checkTz !== undefined) {
          existing.checkTz = params.checkTz;
          existing.nextCheckAt = _computeNextCheckAt(existing.checkCron, params.checkTz);
        }
        existing.updatedAt = new Date().toISOString();
        saveGoal(existing);
        return `Goal updated: "${existing.title}" | ID: ${existing.id}`;
      }

      case "delete": {
        if (!params.id) return "Error: id is required.";
        const existing = loadGoal(params.id);
        if (!existing) return `Error: goal ${params.id} not found.`;
        if (existing.tenantId !== tenantId) return "Error: goal belongs to a different tenant.";
        removeGoal(params.id);
        return `Goal ${params.id} removed.`;
      }

      case "pause": {
        if (!params.id) return "Error: id is required.";
        const existing = loadGoal(params.id);
        if (!existing) return `Error: goal ${params.id} not found.`;
        if (existing.tenantId !== tenantId) return "Error: goal belongs to a different tenant.";
        existing.status = "paused";
        existing.updatedAt = new Date().toISOString();
        saveGoal(existing);
        return `Goal "${existing.title}" paused.`;
      }

      case "resume": {
        if (!params.id) return "Error: id is required.";
        const existing = loadGoal(params.id);
        if (!existing) return `Error: goal ${params.id} not found.`;
        if (existing.tenantId !== tenantId) return "Error: goal belongs to a different tenant.";
        existing.status = "active";
        existing.consecutiveFailures = 0;
        existing.nextCheckAt = _computeNextCheckAt(existing.checkCron, existing.checkTz);
        existing.updatedAt = new Date().toISOString();
        saveGoal(existing);
        return `Goal "${existing.title}" resumed - next: ${existing.nextCheckAt || "computing..."}`;
      }

      case "check": {
        if (!params.id) return "Error: id is required.";
        const existing = loadGoal(params.id);
        if (!existing) return `Error: goal ${params.id} not found.`;
        if (existing.tenantId !== tenantId) return "Error: goal belongs to a different tenant.";

        // Set nextCheckAt to now so GoalPulse picks it up on next tick
        existing.nextCheckAt = new Date().toISOString();
        existing.updatedAt = new Date().toISOString();
        if (existing.status !== "active") {
          existing.status = "active";
          existing.consecutiveFailures = 0;
        }
        saveGoal(existing);
        return `Goal "${existing.title}" queued for immediate check.`;
      }

      case "complete": {
        if (!params.id) return "Error: id is required.";
        const existing = loadGoal(params.id);
        if (!existing) return `Error: goal ${params.id} not found.`;
        if (existing.tenantId !== tenantId) return "Error: goal belongs to a different tenant.";
        existing.status = "completed";
        existing.updatedAt = new Date().toISOString();
        saveGoal(existing);
        return `Goal "${existing.title}" marked as completed.`;
      }

      default:
        return `Unknown action: "${action}". Available: create, list, update, delete, pause, resume, check, complete`;
    }
  } catch (error) {
    return `Goal error: ${error.message}`;
  }
}

export const goalDescription =
  "goal(action, ...) - Manage persistent autonomous goals. Agent works toward them on a cron schedule. " +
  "Actions: create, list, update, delete, pause, resume, check (force-check now), complete.";
