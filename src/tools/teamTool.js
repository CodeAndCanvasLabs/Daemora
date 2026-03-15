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
  storeContext,
  readContext,
  searchContext,
  workspaceSummary,
  getEventLog,
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
        const { teamId, title, description, blockedBy, priority } = params;
        if (!teamId || !title) return "Error: teamId and title are required";
        const taskList = getTaskList(teamId);
        return JSON.stringify(taskList.add({ title, description, blockedBy, priority }));
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
        return tasks.map(t => `[${t.priority}] ${t.id} "${t.title}"`).join("\n");
      }

      case "executionOrder": {
        const { teamId } = params;
        if (!teamId) return "Error: teamId is required";
        const taskList = getTaskList(teamId);
        const order = taskList.resolveExecutionOrder();
        return order.map((t, i) => `${i + 1}. [${t.priority}] ${t.id} "${t.title}" ${t.blockedBy?.length > 0 ? `(after: ${t.blockedBy.join(",")})` : ""}`).join("\n");
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

      // ── Shared Workspace (cross-agent context) ─────────────────────────────

      case "storeContext": {
        const { teamId, key, value, author } = params;
        if (!teamId || !key || !value) return "Error: teamId, key, and value are required";
        return JSON.stringify(storeContext(teamId, key, value, author));
      }

      case "readContext": {
        const { teamId, key } = params;
        if (!teamId) return "Error: teamId is required";
        const result = readContext(teamId, key);
        if (!result) return key ? `No context found for key "${key}".` : "Workspace is empty.";
        return JSON.stringify(result, null, 2);
      }

      case "searchContext": {
        const { teamId, query } = params;
        if (!teamId || !query) return "Error: teamId and query are required";
        const results = searchContext(teamId, query);
        if (results.length === 0) return `No workspace entries matching "${query}".`;
        return results.map(r => `[${r.author}] ${r.key}: ${r.value.slice(0, 200)}`).join("\n\n");
      }

      case "workspace": {
        const { teamId } = params;
        if (!teamId) return "Error: teamId is required";
        const summary = workspaceSummary(teamId);
        if (summary.length === 0) return "Workspace is empty.";
        return summary.map(e => `${e.key} (by ${e.author}, ${e.size} chars)`).join("\n");
      }

      // ── Event Log ──────────────────────────────────────────────────────────

      case "eventLog": {
        const { teamId, event, agentId, taskId, limit } = params;
        if (!teamId) return "Error: teamId is required";
        const log = getEventLog(teamId, { event, agentId, taskId, limit: limit ? parseInt(limit) : 50 });
        if (log.length === 0) return "No events logged.";
        return log.map(e => `[${e.time}] ${e.event}${e.agentId ? ` (${e.agentId})` : ""}${e.taskId ? ` task:${e.taskId}` : ""} ${JSON.stringify(e.data)}`).join("\n");
      }

      default:
        return `Unknown action: "${action}". Valid: createTeam, addTeammate, spawnTeammate, spawnAll, restart, addTask, claim, complete, failTask, listTasks, claimable, executionOrder, sendMessage, broadcast, readMail, mailHistory, storeContext, readContext, searchContext, workspace, eventLog, status, disband`;
    }
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

export const teamTaskDescription =
  `teamTask(action: string, paramsJson?: string) - Manage agent teams with shared tasks, messaging, and workspace.
  Actions:
    createTeam      - {"name":"..."} → create team, returns teamId
    addTeammate     - {"teamId":"...","profile":"coder|researcher|writer|analyst|...","instructions":"...","id":"..."} → register teammate (21 profiles available)
    spawnTeammate   - {"teamId":"...","teammateId":"...","context":"..."} → start one teammate
    spawnAll        - {"teamId":"...","context":"..."} → start all idle teammates
    restart         - {"teamId":"...","teammateId":"...","context":"..."} → restart finished/failed teammate (max 3x, auto-unclaims tasks)
    addTask         - {"teamId":"...","title":"...","description":"...","blockedBy":["taskId"],"priority":"critical|high|medium|low"} → add to shared task list
    claim           - {"teamId":"...","taskId":"...","teammateId":"..."} → lock task for self
    complete        - {"teamId":"...","taskId":"...","teammateId":"...","result":"..."} → mark done
    failTask        - {"teamId":"...","taskId":"...","teammateId":"...","reason":"..."} → release back to pool
    listTasks       - {"teamId":"...","status":"...","assignee":"..."} → query tasks
    claimable       - {"teamId":"..."} → tasks with deps met, sorted by priority
    executionOrder  - {"teamId":"..."} → topological sort of all tasks (dependency + priority order)
    storeContext    - {"teamId":"...","key":"...","value":"...","author":"..."} → store finding/decision in shared workspace
    readContext     - {"teamId":"...","key":"..."} → read from shared workspace (key or all)
    searchContext   - {"teamId":"...","query":"..."} → search workspace by keyword
    workspace       - {"teamId":"..."} → list workspace keys + authors
    sendMessage     - {"teamId":"...","to":"teammateId","message":"..."} → direct message
    broadcast       - {"teamId":"...","message":"..."} → message all teammates
    readMail        - {"teamId":"...","recipientId":"..."} → read unread messages
    mailHistory     - {"teamId":"...","limit":50} → full message log
    eventLog        - {"teamId":"...","event":"...","agentId":"...","limit":50} → team event history
    status          - {"teamId":"..."} → full team status
    disband         - {"teamId":"..."} → stop all, cleanup
  Workflow: createTeam → addTeammate(s) → addTask(s) with deps + priority → spawnAll → agents storeContext findings → monitor via status → disband
  Workspace: agents share findings via storeContext/readContext. Researcher stores findings → coder reads and implements → tester reads and validates.`;
