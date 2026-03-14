/**
 * teamTask — Agent-facing tool for team management.
 *
 * Single tool with action-based dispatch (same pattern as taskManager.js).
 * Covers full team lifecycle: create, teammates, tasks, messaging, status, disband.
 */

import { mergeLegacyParams as _mergeLegacy } from "../utils/mergeToolParams.js";
import {
  createTeam,
  addTeammate,
  spawnTeammate,
  spawnAll,
  restartTeammate,
  messageTeammate,
  broadcastToTeam,
  getTeamStatus,
  disbandTeam,
  getMailbox,
  getTaskList,
} from "../agents/TeamManager.js";

export function teamTask(toolParams) {
  const action = toolParams?.action;
  const params = _mergeLegacy(toolParams);

  try {
    switch (action) {

      // ── Team lifecycle ──────────────────────────────────────────────────────

      case "createTeam": {
        const { name } = params;
        if (!name) return "Error: name is required";
        return JSON.stringify(createTeam(name));
      }

      case "addTeammate": {
        const { teamId, profile, instructions, id } = params;
        if (!teamId) return "Error: teamId is required";
        return JSON.stringify(addTeammate(teamId, { id, profile, instructions }));
      }

      case "spawnTeammate": {
        const { teamId, teammateId, context } = params;
        if (!teamId || !teammateId) return "Error: teamId and teammateId are required";
        return JSON.stringify(spawnTeammate(teamId, teammateId, { context }));
      }

      case "spawnAll": {
        const { teamId, context } = params;
        if (!teamId) return "Error: teamId is required";
        const results = spawnAll(teamId, { context });
        return results.length > 0
          ? `Spawned ${results.length} teammate(s): ${results.map(r => r.teammateId).join(", ")}`
          : "No idle teammates to spawn.";
      }

      case "restart": {
        const { teamId, teammateId, context } = params;
        if (!teamId || !teammateId) return "Error: teamId and teammateId are required";
        return JSON.stringify(restartTeammate(teamId, teammateId, { context }));
      }

      // ── Shared task list ────────────────────────────────────────────────────

      case "addTask": {
        const { teamId, title, description, blockedBy } = params;
        if (!teamId || !title) return "Error: teamId and title are required";
        const taskList = getTaskList(teamId);
        return JSON.stringify(taskList.add({ title, description, blockedBy }));
      }

      case "claim": {
        const { teamId, taskId, teammateId } = params;
        if (!teamId || !taskId) return "Error: teamId and taskId are required";
        const taskList = getTaskList(teamId);
        return JSON.stringify(taskList.claim(taskId, teammateId || "lead"));
      }

      case "complete": {
        const { teamId, taskId, result, teammateId } = params;
        if (!teamId || !taskId) return "Error: teamId and taskId are required";
        const taskList = getTaskList(teamId);
        return JSON.stringify(taskList.complete(taskId, teammateId || "lead", result));
      }

      case "failTask": {
        const { teamId, taskId, reason, teammateId } = params;
        if (!teamId || !taskId) return "Error: teamId and taskId are required";
        const taskList = getTaskList(teamId);
        return JSON.stringify(taskList.fail(taskId, teammateId || "lead", reason));
      }

      case "listTasks": {
        const { teamId, status, assignee } = params;
        if (!teamId) return "Error: teamId is required";
        const taskList = getTaskList(teamId);
        const tasks = taskList.list({ status, assignee });
        if (tasks.length === 0) return "No tasks found.";
        return tasks.map(t => {
          const icon = t.status === "completed" ? "done" : t.status === "claimed" ? "claimed" : t.status === "pending" ? "pending" : t.status;
          const assigneeStr = t.assignee ? ` [${t.assignee}]` : "";
          const deps = t.blockedBy?.length > 0 ? ` blocked-by: ${t.blockedBy.join(",")}` : "";
          return `[${icon}] ${t.id} "${t.title}"${assigneeStr}${deps}`;
        }).join("\n");
      }

      case "claimable": {
        const { teamId } = params;
        if (!teamId) return "Error: teamId is required";
        const taskList = getTaskList(teamId);
        const tasks = taskList.claimable();
        if (tasks.length === 0) return "No claimable tasks (all claimed, blocked, or completed).";
        return tasks.map(t => `[pending] ${t.id} "${t.title}"`).join("\n");
      }

      // ── Messaging ─────────────────────────────────────────────────────────

      case "sendMessage": {
        const { teamId, to, message } = params;
        if (!teamId || !to || !message) return "Error: teamId, to, and message are required";
        const from = params.from || "lead";
        return JSON.stringify(messageTeammate(teamId, to, message, from));
      }

      case "broadcast": {
        const { teamId, message } = params;
        if (!teamId || !message) return "Error: teamId and message are required";
        const from = params.from || "lead";
        return JSON.stringify(broadcastToTeam(teamId, message, from));
      }

      case "readMail": {
        const { teamId, recipientId } = params;
        if (!teamId) return "Error: teamId is required";
        const mailbox = getMailbox(teamId);
        const messages = mailbox.readFor(recipientId || "lead");
        if (messages.length === 0) return "No unread messages.";
        return messages.map(m =>
          `[${new Date(m.timestamp).toISOString().slice(11, 19)}] ${m.from} → ${m.to}: ${m.content}`
        ).join("\n");
      }

      case "mailHistory": {
        const { teamId, limit } = params;
        if (!teamId) return "Error: teamId is required";
        const mailbox = getMailbox(teamId);
        const messages = mailbox.history({ limit: limit || 50 });
        if (messages.length === 0) return "No messages.";
        return messages.map(m =>
          `[${new Date(m.timestamp).toISOString().slice(11, 19)}] ${m.from} → ${m.to}: ${m.content}`
        ).join("\n");
      }

      // ── Status & lifecycle ────────────────────────────────────────────────

      case "status": {
        const { teamId } = params;
        if (!teamId) return "Error: teamId is required";
        return JSON.stringify(getTeamStatus(teamId), null, 2);
      }

      case "disband": {
        const { teamId } = params;
        if (!teamId) return "Error: teamId is required";
        return JSON.stringify(disbandTeam(teamId));
      }

      default:
        return `Unknown action: "${action}". Valid: createTeam, addTeammate, spawnTeammate, spawnAll, restart, addTask, claim, complete, failTask, listTasks, claimable, sendMessage, broadcast, readMail, mailHistory, status, disband`;
    }
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

export const teamTaskDescription =
  `teamTask(action: string, paramsJson?: string) - Manage agent teams with shared tasks and messaging.
  Actions:
    createTeam     - {"name":"..."} → create team, returns teamId
    addTeammate    - {"teamId":"...","profile":"coder|researcher|writer|analyst","instructions":"...","id":"..."} → register teammate
    spawnTeammate  - {"teamId":"...","teammateId":"...","context":"..."} → start one teammate
    spawnAll       - {"teamId":"...","context":"..."} → start all idle teammates
    restart        - {"teamId":"...","teammateId":"...","context":"..."} → restart finished/failed teammate (max 3 restarts, auto-unclaims tasks)
    addTask        - {"teamId":"...","title":"...","description":"...","blockedBy":["taskId"]} → add to shared task list
    claim          - {"teamId":"...","taskId":"...","teammateId":"..."} → lock task for self
    complete       - {"teamId":"...","taskId":"...","teammateId":"...","result":"..."} → mark done
    failTask       - {"teamId":"...","taskId":"...","teammateId":"...","reason":"..."} → release back to pool
    listTasks      - {"teamId":"...","status":"...","assignee":"..."} → query tasks
    claimable      - {"teamId":"..."} → tasks with deps met and unclaimed
    sendMessage    - {"teamId":"...","to":"teammateId","message":"..."} → direct message
    broadcast      - {"teamId":"...","message":"..."} → message all teammates
    readMail       - {"teamId":"...","recipientId":"..."} → read unread messages
    mailHistory    - {"teamId":"...","limit":50} → full message log
    status         - {"teamId":"..."} → full team status (teammates, tasks, messages)
    disband        - {"teamId":"..."} → stop all teammates, cleanup
  Workflow: createTeam → addTeammate(s) → addTask(s) with blockedBy deps → spawnAll → monitor via status/readMail → restart if needed → disband`;
