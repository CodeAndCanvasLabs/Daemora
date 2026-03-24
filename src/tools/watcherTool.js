/**
 * watcher(action, ...) - Manage named webhook watchers.
 *
 * Actions:
 *   add      - create a new watcher
 *   list     - list watchers for current tenant
 *   update   - patch an existing watcher
 *   delete   - remove a watcher
 *   enable   - enable a watcher
 *   disable  - disable a watcher
 */
import { randomUUID } from "crypto";
import {
  saveWatcher, loadWatcher, loadWatchersByTenant,
  deleteWatcher as removeWatcher,
} from "../storage/WatcherStore.js";
import tenantContext from "../tenants/TenantContext.js";

function _getTenantId() {
  return tenantContext.getStore()?.tenant?.id || null;
}

function _getChannelMeta() {
  return tenantContext.getStore()?.channelMeta || null;
}

export function watcher(toolParams) {
  const action = toolParams?.action;
  try {
    const { action: _discard, ...params } = toolParams || {};
    const tenantId = _getTenantId();

    switch (action) {
      case "add": {
        if (!params.name) return "Error: name is required.";
        if (!params.taskAction) return "Error: taskAction is required (the task input to execute when triggered).";
        const id = randomUUID().slice(0, 8);
        const now = new Date().toISOString();

        // Auto-set channel from current context
        let channel = params.channel || null;
        let channelMeta = null;
        const ctxMeta = _getChannelMeta();
        if (!channel && ctxMeta) {
          channel = ctxMeta.channel;
          channelMeta = ctxMeta;
        }

        // Parse pattern if provided as JSON string
        let pattern = null;
        if (params.pattern) {
          try {
            pattern = typeof params.pattern === "string" ? JSON.parse(params.pattern) : params.pattern;
          } catch {
            return "Error: pattern must be valid JSON.";
          }
        }

        const watcherObj = {
          id,
          tenantId,
          name: params.name,
          description: params.description || null,
          triggerType: params.triggerType || "webhook",
          pattern,
          action: params.taskAction,
          channel,
          channelMeta,
          enabled: 1,
          lastTriggeredAt: null,
          triggerCount: 0,
          cooldownSeconds: params.cooldownSeconds ?? 0,
          createdAt: now,
          updatedAt: now,
        };

        saveWatcher(watcherObj);
        return `Watcher created: "${watcherObj.name}" | trigger: ${watcherObj.triggerType} | cooldown: ${watcherObj.cooldownSeconds}s | ID: ${id}\nEndpoint: POST /hooks/watch/${encodeURIComponent(watcherObj.name)}`;
      }

      case "list": {
        const watchers = loadWatchersByTenant(tenantId);
        if (watchers.length === 0) return "No watchers configured.";
        return watchers.map(w => {
          const status = w.enabled ? "enabled" : "disabled";
          const pattern = w.pattern ? ` | pattern: ${JSON.stringify(w.pattern)}` : "";
          return `• ${w.id} "${w.name}" | ${status} | trigger: ${w.triggerType} | cooldown: ${w.cooldownSeconds}s | fired: ${w.triggerCount}x${pattern}`;
        }).join("\n");
      }

      case "update": {
        if (!params.id) return 'Error: id is required. Use watcher("list") to see watcher IDs.';
        const existing = loadWatcher(params.id);
        if (!existing) return `Error: watcher ${params.id} not found.`;
        if (existing.tenantId !== tenantId) return "Error: watcher belongs to a different tenant.";

        if (params.name !== undefined) existing.name = params.name;
        if (params.description !== undefined) existing.description = params.description;
        if (params.taskAction !== undefined) existing.action = params.taskAction;
        if (params.triggerType !== undefined) existing.triggerType = params.triggerType;
        if (params.channel !== undefined) existing.channel = params.channel;
        if (params.cooldownSeconds !== undefined) existing.cooldownSeconds = params.cooldownSeconds;
        if (params.pattern !== undefined) {
          try {
            existing.pattern = typeof params.pattern === "string" ? JSON.parse(params.pattern) : params.pattern;
          } catch {
            return "Error: pattern must be valid JSON.";
          }
        }
        existing.updatedAt = new Date().toISOString();
        saveWatcher(existing);
        return `Watcher updated: "${existing.name}" | ID: ${existing.id}`;
      }

      case "delete": {
        if (!params.id) return "Error: id is required.";
        const existing = loadWatcher(params.id);
        if (!existing) return `Error: watcher ${params.id} not found.`;
        if (existing.tenantId !== tenantId) return "Error: watcher belongs to a different tenant.";
        removeWatcher(params.id);
        return `Watcher ${params.id} removed.`;
      }

      case "enable": {
        if (!params.id) return "Error: id is required.";
        const existing = loadWatcher(params.id);
        if (!existing) return `Error: watcher ${params.id} not found.`;
        if (existing.tenantId !== tenantId) return "Error: watcher belongs to a different tenant.";
        existing.enabled = 1;
        existing.updatedAt = new Date().toISOString();
        saveWatcher(existing);
        return `Watcher "${existing.name}" enabled.`;
      }

      case "disable": {
        if (!params.id) return "Error: id is required.";
        const existing = loadWatcher(params.id);
        if (!existing) return `Error: watcher ${params.id} not found.`;
        if (existing.tenantId !== tenantId) return "Error: watcher belongs to a different tenant.";
        existing.enabled = 0;
        existing.updatedAt = new Date().toISOString();
        saveWatcher(existing);
        return `Watcher "${existing.name}" disabled.`;
      }

      default:
        return `Unknown action: "${action}". Available: add, list, update, delete, enable, disable`;
    }
  } catch (error) {
    return `Watcher error: ${error.message}`;
  }
}

export const watcherDescription =
  "watcher(action, ...) - Manage named watchers - event-driven triggers that execute tasks when webhooks fire. " +
  "Actions: add, list, update, delete, enable, disable.";
