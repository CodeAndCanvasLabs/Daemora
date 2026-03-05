import { v4 as uuidv4 } from "uuid";
import { createTask, startTask, completeTask, failTask } from "../core/Task.js";
import { saveTask, loadTask, listTasks, listChildTasks } from "../storage/TaskStore.js";
import tenantContext from "../tenants/TenantContext.js";

/**
 * Task Manager - Agent-facing tool for creating and tracking tasks.
 *
 * Unlike projectTracker (which is a separate project/task system),
 * this creates real Task records in TaskStore that appear in the UI
 * and integrate with sub-agent tracking.
 *
 * Actions:
 *   createTask  - create a new agent task (type: "task")
 *   updateTask  - update status/result of a task
 *   listTasks   - list agent-created tasks
 *   getTask     - get full task details + children
 */

export function taskManager(action, paramsJson) {
  const params = paramsJson
    ? (typeof paramsJson === "string" ? JSON.parse(paramsJson) : paramsJson)
    : {};

  // Get current context for parentTaskId linkage
  const store = tenantContext.getStore();

  switch (action) {

    // ── Create task ─────────────────────────────────────────────────────────
    case "createTask": {
      const { title, description = "", status = "pending", parentTaskId = null } = params;
      if (!title) return "Error: title is required";

      // Auto-link to current executing task if no explicit parent
      const effectiveParentId = parentTaskId || store?.currentTaskId || null;

      const task = createTask({
        input: description || title,
        type: "task",
        title,
        description,
        parentTaskId: effectiveParentId,
        agentCreated: true,
        agentId: store?.agentId || null,
        channel: "agent",
        sessionId: store?.sessionId || null,
      });

      // If created with a non-pending status, apply it
      if (status === "in_progress") startTask(task);
      else if (status === "completed") {
        startTask(task);
        completeTask(task, "Created as completed");
      }

      saveTask(task);

      const parentStr = effectiveParentId ? ` (child of ${effectiveParentId.slice(0, 8)})` : "";
      return `Task created: ${task.id} "${title}"${parentStr} — status: ${task.status}`;
    }

    // ── Update task ─────────────────────────────────────────────────────────
    case "updateTask": {
      const { taskId, status, result, agentId } = params;
      if (!taskId) return "Error: taskId is required";

      const task = loadTask(taskId);
      if (!task) return `Error: Task "${taskId}" not found`;

      if (agentId) task.agentId = agentId;

      if (status) {
        const oldStatus = task.status;
        switch (status) {
          case "in_progress":
            if (task.status === "pending") startTask(task);
            else task.status = "in_progress";
            break;
          case "completed":
            completeTask(task, result || task.result || "");
            break;
          case "failed":
            failTask(task, result || "Task failed");
            break;
          default:
            return `Error: Invalid status "${status}". Use: pending, in_progress, completed, failed`;
        }
        saveTask(task);
        return `Task ${taskId} "${task.title || task.input?.slice(0, 40)}": ${oldStatus} → ${status}`;
      }

      saveTask(task);
      return `Task ${taskId} updated`;
    }

    // ── List tasks ──────────────────────────────────────────────────────────
    case "listTasks": {
      const { status = null, parentTaskId = null, limit = 20 } = params;

      let tasks = listTasks({ limit, status, type: "task" });

      if (parentTaskId) {
        tasks = tasks.filter(t => t.parentTaskId === parentTaskId);
      }

      if (tasks.length === 0) return "No agent-created tasks found.";

      return tasks.map(t => {
        const icon = t.status === "completed" ? "✅" : t.status === "running" ? "🔄" : t.status === "failed" ? "❌" : "⬜";
        const agent = t.agentId ? ` [agent:${t.agentId}]` : "";
        const parent = t.parentTaskId ? ` ← ${t.parentTaskId}` : "";
        return `${icon} ${t.id} ${t.title || t.input?.slice(0, 50)}${agent}${parent} — ${t.status}`;
      }).join("\n");
    }

    // ── Get task details ────────────────────────────────────────────────────
    case "getTask": {
      const { taskId } = params;
      if (!taskId) return "Error: taskId is required";

      const task = loadTask(taskId);
      if (!task) return `Error: Task "${taskId}" not found`;

      const children = listChildTasks(taskId);

      const lines = [
        `Task: ${task.title || task.input?.slice(0, 60)} [${task.id.slice(0, 8)}]`,
        `Type: ${task.type || "chat"} | Status: ${task.status}`,
        task.description ? `Description: ${task.description}` : null,
        task.agentId ? `Agent: ${task.agentId}` : null,
        task.parentTaskId ? `Parent: ${task.parentTaskId.slice(0, 8)}` : null,
        task.cost?.estimatedCost ? `Cost: $${task.cost.estimatedCost.toFixed(4)}` : null,
        task.toolCalls?.length ? `Tool calls: ${task.toolCalls.length}` : null,
        task.subAgents?.length ? `Sub-agents: ${task.subAgents.length}` : null,
      ].filter(Boolean);

      if (children.length > 0) {
        lines.push("", `Children (${children.length}):`);
        for (const child of children) {
          const icon = child.status === "completed" ? "✅" : child.status === "running" ? "🔄" : child.status === "failed" ? "❌" : "⬜";
          const agent = child.agentId ? ` [${child.agentId.slice(0, 8)}]` : "";
          lines.push(`  ${icon} [${child.id.slice(0, 8)}] ${child.title || child.input?.slice(0, 40)}${agent} — ${child.status}`);
        }
      }

      return lines.join("\n");
    }

    default:
      return `Unknown action: "${action}". Valid: createTask, updateTask, listTasks, getTask`;
  }
}

export const taskManagerDescription =
  `taskManager(action: string, paramsJson?: string) - Create, update, and monitor tasks. Tasks appear in the UI and link to sub-agents.
  Actions:
    createTask  - {"title":"...","description":"...","status":"pending|in_progress"} → returns full task ID
    updateTask  - {"taskId":"<full-uuid>","status":"completed|failed","result":"summary of what was done"}
    listTasks   - {} or {"status":"running","parentTaskId":"<uuid>"} → list tasks with IDs and status
    getTask     - {"taskId":"<full-uuid>"} → full details + child tasks + sub-agent info
  Statuses: pending | in_progress | completed | failed
  Tasks auto-link to the current parent task. Use createTask before starting each step, updateTask when done.
  When spawning sub-agents, include the task ID in their description so they can call updateTask on it.`;
