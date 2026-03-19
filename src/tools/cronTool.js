/**
 * cron(action, paramsJson?) - Manage scheduled tasks.
 *
 * Actions:
 *   status      - scheduler status (jobs, next wake, running count)
 *   list        - list all jobs (tenant-scoped if in tenant context)
 *   add         - create a new job (cron, every, or at schedule)
 *   update      - patch an existing job
 *   enable      - re-enable a disabled job
 *   disable     - pause a job without deleting it
 *   remove      - delete a job permanently
 *   run         - trigger a job immediately
 *   history     - get run history for a job
 *   listPresets - list available delivery presets (for deliveryPreset param)
 */
import scheduler from "../scheduler/Scheduler.js";
import tenantContext from "../tenants/TenantContext.js";
import { listPresets } from "../scheduler/DeliveryPresetStore.js";

function _getTenantId() {
  return tenantContext.getStore()?.tenant?.id || null;
}

function _getChannelMeta() {
  return tenantContext.getStore()?.channelMeta || null;
}

export function cron(toolParams) {
  const action = toolParams?.action;
  try {
    // Support both flat fields (new schema) and legacy JSON params string
    const paramsJson = toolParams?.params;
    const legacyParams = paramsJson ? JSON.parse(paramsJson) : {};
    const { params: _discard, action: _discard2, ...flatFields } = toolParams || {};
    const params = { ...legacyParams, ...flatFields };
    const tenantId = _getTenantId();

    switch (action) {
      case "status": {
        return JSON.stringify(scheduler.status());
      }

      case "list": {
        const jobs = scheduler.list(tenantId);
        if (jobs.length === 0) return "No cron jobs configured.";
        return jobs.map((j) => {
          const sched = j.schedule.kind === "cron" ? j.schedule.expr
            : j.schedule.kind === "every" ? `every ${Math.round(j.schedule.everyMs / 1000)}s`
            : `at ${j.schedule.at}`;
          const tz = j.schedule.tz ? ` (${j.schedule.tz})` : "";
          const status = j.runningSince ? "RUNNING" : j.enabled ? "enabled" : "DISABLED";
          const delivery = j.delivery?.mode !== "none" ? ` → ${j.delivery.mode}` : "";
          return `• ${j.id.slice(0, 8)} "${j.name}" | ${sched}${tz} | ${status} | runs: ${j.runCount} | last: ${j.lastStatus || "never"} | next: ${j.nextRunAt || "n/a"}${delivery}`;
        }).join("\n");
      }

      case "add": {
        if (!params.taskInput) return "Error: taskInput is required.";

        // Build schedule from params
        let schedule;
        if (params.schedule) {
          schedule = params.schedule;
        } else if (params.cronExpression) {
          schedule = { kind: "cron", expr: params.cronExpression, tz: params.timezone || null };
        } else if (params.every) {
          schedule = { kind: "every", everyMs: _parseInterval(params.every) };
        } else if (params.at) {
          schedule = { kind: "at", at: params.at };
        } else {
          return 'Error: schedule is required. Use cronExpression ("0 9 * * *"), every ("30m"), or at ("2026-03-15T10:00:00Z").';
        }

        if (params.staggerMs) schedule.staggerMs = params.staggerMs;

        // Admin-only: delivery preset (resolves named group → preset ID)
        const store = tenantContext.getStore();
        const isAdmin = !tenantId || tenantId === "__global__" || store?.tenant?.globalAdmin === true;
        const deliveryPreset = isAdmin ? (params.deliveryPreset || null) : null;

        // Build delivery — preset takes priority over auto-announce
        let delivery = params.delivery || { mode: "none" };
        if (!deliveryPreset && delivery.mode === "none") {
          const channelMeta = _getChannelMeta();
          if (channelMeta) {
            delivery = { mode: "announce", channel: channelMeta.channel, to: null, channelMeta };
          }
        }

        const job = scheduler.create({
          schedule,
          taskInput: params.taskInput,
          name: params.name,
          tenantId,
          model: params.model,
          thinking: params.thinking,
          timeoutSeconds: params.timeoutSeconds,
          delivery,
          deliveryPreset,
          maxRetries: params.maxRetries,
          retryBackoffMs: params.retryBackoffMs,
          failureAlert: params.failureAlert,
          deleteAfterRun: params.deleteAfterRun,
        });

        const schedDesc = schedule.kind === "cron" ? schedule.expr
          : schedule.kind === "every" ? `every ${Math.round(schedule.everyMs / 1000)}s`
          : `at ${schedule.at}`;

        return `Job created: "${job.name}" | ${schedDesc} | delivery: ${job.delivery.mode}${job.delivery.presetId ? ` (preset)` : ""} | ID: ${job.id.slice(0, 8)} | next: ${job.nextRunAt || "now"}`;
      }

      case "update": {
        if (!params.id) return 'Error: id is required. Use cron("list") to see job IDs.';
        const patch = { ...params };
        delete patch.id;

        // Handle legacy cronExpression in patch
        if (patch.cronExpression && !patch.schedule) {
          patch.schedule = { kind: "cron", expr: patch.cronExpression, tz: patch.timezone || null };
          delete patch.cronExpression;
          delete patch.timezone;
        }
        // Handle every/at shorthand in patch
        if (patch.every && !patch.schedule) {
          patch.schedule = { kind: "every", everyMs: _parseInterval(patch.every) };
          delete patch.every;
        }
        if (patch.at && !patch.schedule) {
          patch.schedule = { kind: "at", at: patch.at };
          delete patch.at;
        }

        const job = scheduler.update(params.id, patch, tenantId);
        return `Job updated: "${job.name}" | ID: ${job.id.slice(0, 8)}`;
      }

      case "enable": {
        if (!params.id) return "Error: id is required.";
        const job = scheduler.update(params.id, { enabled: true }, tenantId);
        return `Job "${job.name}" enabled — next run: ${job.nextRunAt || "computing..."}`;
      }

      case "disable": {
        if (!params.id) return "Error: id is required.";
        const job = scheduler.update(params.id, { enabled: false }, tenantId);
        return `Job "${job.name}" disabled — paused, not deleted.`;
      }

      case "remove": {
        if (!params.id) return 'Error: id is required.';
        scheduler.delete(params.id, tenantId);
        return `Job ${params.id.slice(0, 8)} removed.`;
      }

      case "run": {
        if (!params.id) return "Error: id is required.";
        // Fire-and-forget — don't await, just trigger
        scheduler.forceRun(params.id, tenantId).catch(e =>
          console.log(`[cron] Force-run error: ${e.message}`)
        );
        return `Job ${params.id.slice(0, 8)} triggered. Check history for results.`;
      }

      case "listPresets": {
        const presets = listPresets();
        if (presets.length === 0) return "No delivery presets configured. Admin can create them from Cron → Presets in the dashboard.";
        return presets.map(p =>
          `• "${p.name}" — ${p.targets.length} target(s)${p.description ? ` | ${p.description}` : ""}`
        ).join("\n");
      }

      case "history": {
        if (!params.id) return "Error: id is required.";
        const runs = scheduler.getHistory(params.id, {
          limit: params.limit || 10,
          offset: params.offset || 0,
          status: params.status || null,
        });
        if (runs.length === 0) return "No run history for this job.";
        return runs.map(r =>
          `[${r.started_at}] ${r.status}${r.duration_ms ? ` (${Math.round(r.duration_ms / 1000)}s)` : ""}${r.error ? ` — ${r.error.slice(0, 100)}` : ""}${r.delivery_status !== "not-requested" ? ` | delivery: ${r.delivery_status}` : ""}`
        ).join("\n");
      }

      default:
        return `Unknown action: "${action}". Available: status, list, add, update, enable, disable, remove, run, history, listPresets`;
    }
  } catch (error) {
    return `Cron error: ${error.message}`;
  }
}

/**
 * Parse interval shorthand: "30s", "5m", "2h", "1d" → milliseconds.
 */
function _parseInterval(str) {
  if (typeof str === "number") return str;
  const match = String(str).match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) throw new Error(`Invalid interval: "${str}". Use format like "30s", "5m", "2h", "1d".`);
  const n = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const ms = n * multipliers[unit];
  if (ms < 10000) throw new Error("Interval must be at least 10 seconds.");
  return ms;
}

export const cronDescription =
  'cron(action, ...) - Schedule and manage cron jobs. Delivery auto-routes to calling channel. ' +
  'Schedule types: cronExpression (recurring), every (interval), at (one-shot ISO timestamp).';
