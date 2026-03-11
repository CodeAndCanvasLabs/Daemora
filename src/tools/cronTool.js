/**
 * cron(action, paramsJson?) - Schedule recurring tasks from within the agent.
 * Bridge to the existing Scheduler. Inspired by OpenClaw's cron tool.
 *
 * Actions:
 *   status  - show scheduler status
 *   list    - list all schedules
 *   add     - create a new schedule
 *   update  - patch an existing schedule (change expression, name, or taskInput)
 *   enable  - re-enable a disabled schedule
 *   disable - pause a schedule without deleting it
 *   remove  - delete a schedule permanently
 *   run     - trigger a schedule immediately (regardless of cron timing)
 */
import scheduler from "../scheduler/Scheduler.js";
import tenantContext from "../tenants/TenantContext.js";

export function cron(toolParams) {
  const action = toolParams?.action;
  const paramsJson = toolParams?.params;
  try {
    const params = paramsJson ? JSON.parse(paramsJson) : {};

    switch (action) {
      case "status": {
        const schedules = scheduler.list();
        return JSON.stringify({
          running: scheduler.running,
          total: schedules.length,
          enabled: schedules.filter((s) => s.enabled).length,
          disabled: schedules.filter((s) => !s.enabled).length,
        });
      }

      case "list": {
        const schedules = scheduler.list();
        if (schedules.length === 0) return "No schedules configured.";
        return schedules
          .map(
            (s) =>
              `• ${s.id.slice(0, 8)} - "${s.name}" | ${s.cronExpression} | ${s.enabled ? "enabled" : "DISABLED"} | runs: ${s.runCount} | last: ${s.lastRun || "never"}`
          )
          .join("\n");
      }

      case "add": {
        if (!params.cronExpression) return 'Error: cronExpression is required. Example: "0 9 * * *" for daily at 9am.';
        if (!params.taskInput) return "Error: taskInput is required - the task/message to send when triggered.";
        // Auto-inherit channel + channelMeta from current context
        const store = tenantContext.getStore();
        const channel = params.channel || store?.channelMeta?.channel || "scheduler";
        const channelMeta = store?.channelMeta || null;
        const schedule = scheduler.create({
          cronExpression: params.cronExpression,
          taskInput: params.taskInput,
          name: params.name,
          channel,
          channelMeta,
          model: params.model,
        });
        return `Schedule created: "${schedule.name}" | ${schedule.cronExpression} | channel: ${channel} | ID: ${schedule.id.slice(0, 8)}`;
      }

      case "update": {
        if (!params.id) return 'Error: id is required. Use cron("list") to see schedule IDs.';
        // Allow partial prefix ID match (first 8 chars is enough)
        const schedule = scheduler.update(params.id, {
          cronExpression: params.cronExpression,
          taskInput: params.taskInput,
          name: params.name,
        });
        return `Schedule updated: "${schedule.name}" | ${schedule.cronExpression} | ID: ${schedule.id.slice(0, 8)}`;
      }

      case "enable": {
        if (!params.id) return 'Error: id is required.';
        const schedule = scheduler.update(params.id, { enabled: true });
        return `Schedule "${schedule.name}" (${params.id.slice(0, 8)}) enabled - will run on next trigger.`;
      }

      case "disable": {
        if (!params.id) return 'Error: id is required.';
        const schedule = scheduler.update(params.id, { enabled: false });
        return `Schedule "${schedule.name}" (${params.id.slice(0, 8)}) disabled - cron job paused, not deleted.`;
      }

      case "remove": {
        if (!params.id) return 'Error: id is required. Use cron("list") to see schedule IDs.';
        scheduler.delete(params.id);
        return `Schedule ${params.id.slice(0, 8)} removed.`;
      }

      case "run": {
        if (!params.id) return 'Error: id is required. Use cron("list") to see schedule IDs.';
        scheduler.triggerSchedule(params.id);
        return `Schedule ${params.id.slice(0, 8)} triggered manually.`;
      }

      default:
        return `Unknown action: "${action}". Available: status, list, add, update, enable, disable, remove, run`;
    }
  } catch (error) {
    return `Cron error: ${error.message}`;
  }
}

export const cronDescription =
  'cron(action, paramsJson?) - Manage scheduled recurring tasks. ' +
  'Actions: "status", "list", ' +
  '"add" ({"cronExpression":"0 9 * * *","taskInput":"Check emails","name":"Morning"}), ' +
  '"update" ({"id":"...","cronExpression":"0 10 * * *"}), ' +
  '"enable" ({"id":"..."}), "disable" ({"id":"..."}), ' +
  '"remove" ({"id":"..."}), "run" ({"id":"..."}).';
