/**
 * TeamStore — SQLite persistence for teams, members, tasks, and mailbox.
 *
 * Pattern: ClawTeam's file-based persistence adapted for SQLite.
 * All operations are atomic via SQLite transactions.
 * Survives server restarts (unlike old in-memory TeamManager).
 */

import { queryAll, queryOne, run, transaction } from "../storage/Database.js";
import { v4 as uuidv4 } from "uuid";

// ── Teams ───────────────────────────────────────────────────────────────────

export function createTeam({ name, tenantId = null, config = null }) {
  const id = uuidv4().slice(0, 8);
  run(
    `INSERT INTO teams (id, name, tenant_id, config) VALUES ($id, $name, $tid, $cfg)`,
    { $id: id, $name: name, $tid: tenantId, $cfg: config ? JSON.stringify(config) : null }
  );
  return { id, name, tenantId, status: "active" };
}

export function getTeam(id) {
  const row = queryOne("SELECT * FROM teams WHERE id = $id", { $id: id });
  return row ? _rowToTeam(row) : null;
}

export function listTeams(tenantId = null) {
  if (tenantId) {
    return queryAll("SELECT * FROM teams WHERE tenant_id = $tid AND status = 'active' ORDER BY created_at DESC", { $tid: tenantId }).map(_rowToTeam);
  }
  return queryAll("SELECT * FROM teams WHERE status = 'active' ORDER BY created_at DESC").map(_rowToTeam);
}

export function updateTeamStatus(id, status) {
  run("UPDATE teams SET status = $s, updated_at = datetime('now') WHERE id = $id", { $s: status, $id: id });
}

export function setTeamLead(teamId, leadAgentId, leadSessionId) {
  run("UPDATE teams SET lead_agent_id = $aid, lead_session_id = $sid, updated_at = datetime('now') WHERE id = $id",
    { $aid: leadAgentId, $sid: leadSessionId, $id: teamId });
}

function _rowToTeam(row) {
  return {
    id: row.id, name: row.name, tenantId: row.tenant_id,
    leadAgentId: row.lead_agent_id, leadSessionId: row.lead_session_id,
    status: row.status, config: row.config ? JSON.parse(row.config) : null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// ── Members ─────────────────────────────────────────────────────────────────

export function addMember({ teamId, name, role = "worker", profile = null, skills = null, instructions = null }) {
  const id = uuidv4().slice(0, 8);
  run(
    `INSERT INTO team_members (id, team_id, name, role, profile, skills, instructions)
     VALUES ($id, $tid, $name, $role, $profile, $skills, $instructions)`,
    { $id: id, $tid: teamId, $name: name, $role: role, $profile: profile,
      $skills: skills ? JSON.stringify(skills) : null, $instructions: instructions }
  );
  return { id, teamId, name, role, profile, status: "idle" };
}

export function getMember(id) {
  const row = queryOne("SELECT * FROM team_members WHERE id = $id", { $id: id });
  return row ? _rowToMember(row) : null;
}

export function getMemberByName(teamId, name) {
  const row = queryOne("SELECT * FROM team_members WHERE team_id = $tid AND name = $name", { $tid: teamId, $name: name });
  return row ? _rowToMember(row) : null;
}

export function listMembers(teamId) {
  return queryAll("SELECT * FROM team_members WHERE team_id = $tid ORDER BY created_at", { $tid: teamId }).map(_rowToMember);
}

export function updateMemberStatus(id, status, agentId = null, sessionId = null) {
  const updates = ["status = $s", "updated_at = datetime('now')"];
  const params = { $s: status, $id: id };
  if (agentId) { updates.push("agent_id = $aid"); params.$aid = agentId; }
  if (sessionId) { updates.push("session_id = $sid"); params.$sid = sessionId; }
  run(`UPDATE team_members SET ${updates.join(", ")} WHERE id = $id`, params);
}

function _rowToMember(row) {
  return {
    id: row.id, teamId: row.team_id, name: row.name, role: row.role,
    agentId: row.agent_id, sessionId: row.session_id,
    profile: row.profile, skills: row.skills ? JSON.parse(row.skills) : [],
    status: row.status, instructions: row.instructions,
    createdAt: row.created_at,
  };
}

// ── Tasks ────────────────────────────────────────────────────────────────────

export function createTask({ teamId, title, description = null, assignee = null, priority = 2, blockedBy = null }) {
  const id = uuidv4().slice(0, 8);
  run(
    `INSERT INTO team_tasks (id, team_id, title, description, assignee, priority, blocked_by)
     VALUES ($id, $tid, $title, $desc, $assignee, $pri, $blocked)`,
    { $id: id, $tid: teamId, $title: title, $desc: description,
      $assignee: assignee, $pri: priority,
      $blocked: blockedBy?.length ? JSON.stringify(blockedBy) : null }
  );
  return { id, teamId, title, status: "pending", assignee, priority };
}

export function getTask(id) {
  const row = queryOne("SELECT * FROM team_tasks WHERE id = $id", { $id: id });
  return row ? _rowToTask(row) : null;
}

export function listTasks(teamId, { status = null, assignee = null } = {}) {
  let sql = "SELECT * FROM team_tasks WHERE team_id = $tid";
  const params = { $tid: teamId };
  if (status) { sql += " AND status = $s"; params.$s = status; }
  if (assignee) { sql += " AND assignee = $a"; params.$a = assignee; }
  sql += " ORDER BY priority DESC, created_at ASC";
  return queryAll(sql, params).map(_rowToTask);
}

export function updateTask(id, updates) {
  const fields = [];
  const params = { $id: id };
  const allowed = ["status", "assignee", "plan", "plan_feedback", "result", "started_at", "completed_at"];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      const col = key; // column names match
      fields.push(`${col} = $${key}`);
      params[`$${key}`] = updates[key];
    }
  }
  if (fields.length === 0) return;
  fields.push("updated_at = datetime('now')");
  run(`UPDATE team_tasks SET ${fields.join(", ")} WHERE id = $id`, params);
}

/**
 * Auto-unblock tasks when a dependency completes.
 * ClawTeam pattern: when task X completes, remove X from all blocked_by arrays.
 * If a task's blocked_by becomes empty, change status from 'blocked' to 'pending'.
 */
export function resolveDependencies(teamId, completedTaskId) {
  const tasks = queryAll(
    "SELECT id, blocked_by, status FROM team_tasks WHERE team_id = $tid AND blocked_by IS NOT NULL",
    { $tid: teamId }
  );
  for (const row of tasks) {
    try {
      const blockedBy = JSON.parse(row.blocked_by);
      const idx = blockedBy.indexOf(completedTaskId);
      if (idx >= 0) {
        blockedBy.splice(idx, 1);
        const newBlockedBy = blockedBy.length > 0 ? JSON.stringify(blockedBy) : null;
        const newStatus = blockedBy.length === 0 && row.status === "blocked" ? "pending" : row.status;
        run("UPDATE team_tasks SET blocked_by = $b, status = $s, updated_at = datetime('now') WHERE id = $id",
          { $b: newBlockedBy, $s: newStatus, $id: row.id });
      }
    } catch {}
  }
}

function _rowToTask(row) {
  return {
    id: row.id, teamId: row.team_id, title: row.title,
    description: row.description, status: row.status,
    assignee: row.assignee, priority: row.priority,
    blockedBy: row.blocked_by ? JSON.parse(row.blocked_by) : [],
    plan: row.plan, planFeedback: row.plan_feedback,
    result: row.result, startedAt: row.started_at,
    completedAt: row.completed_at, createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Mailbox ─────────────────────────────────────────────────────────────────

/**
 * Send a message. ClawTeam pattern: persistent, per-agent inbox.
 * msg_type: message | plan_request | plan_approved | plan_rejected | status_update | shutdown_request | shutdown_approved
 */
export function sendMessage({ teamId, from, to, msgType = "message", content = null, requestId = null }) {
  run(
    `INSERT INTO team_mailbox (team_id, from_agent, to_agent, msg_type, content, request_id)
     VALUES ($tid, $from, $to, $type, $content, $rid)`,
    { $tid: teamId, $from: from, $to: to, $type: msgType, $content: content, $rid: requestId }
  );
}

/**
 * Broadcast to all members except sender.
 */
export function broadcastMessage({ teamId, from, msgType = "message", content }) {
  const members = queryAll("SELECT name FROM team_members WHERE team_id = $tid", { $tid: teamId });
  for (const m of members) {
    if (m.name === from) continue;
    sendMessage({ teamId, from, to: m.name, msgType, content });
  }
}

/**
 * Read unread messages for an agent. Marks as read (destructive read like ClawTeam).
 */
export function readMessages(teamId, agentName) {
  const msgs = queryAll(
    `SELECT * FROM team_mailbox
     WHERE team_id = $tid AND (to_agent = $to OR to_agent = '*') AND read = 0
     ORDER BY created_at ASC`,
    { $tid: teamId, $to: agentName }
  );
  // Mark as read
  if (msgs.length > 0) {
    const ids = msgs.map(m => m.id);
    run(`UPDATE team_mailbox SET read = 1 WHERE id IN (${ids.join(",")})`, {});
  }
  return msgs.map(_rowToMessage);
}

/**
 * Get message history (all messages, read or unread).
 */
export function messageHistory(teamId, { limit = 50, from = null, to = null } = {}) {
  let sql = "SELECT * FROM team_mailbox WHERE team_id = $tid";
  const params = { $tid: teamId };
  if (from) { sql += " AND from_agent = $from"; params.$from = from; }
  if (to) { sql += " AND (to_agent = $to OR to_agent = '*')"; params.$to = to; }
  sql += " ORDER BY created_at DESC LIMIT $limit";
  params.$limit = limit;
  return queryAll(sql, params).map(_rowToMessage);
}

/**
 * Count unread messages for an agent.
 */
export function unreadCount(teamId, agentName) {
  const row = queryOne(
    "SELECT COUNT(*) as cnt FROM team_mailbox WHERE team_id = $tid AND (to_agent = $to OR to_agent = '*') AND read = 0",
    { $tid: teamId, $to: agentName }
  );
  return row?.cnt || 0;
}

function _rowToMessage(row) {
  return {
    id: row.id, teamId: row.team_id, from: row.from_agent, to: row.to_agent,
    msgType: row.msg_type, content: row.content, requestId: row.request_id,
    read: !!row.read, createdAt: row.created_at,
  };
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

export function cleanupTeam(teamId) {
  transaction(() => {
    run("DELETE FROM team_mailbox WHERE team_id = $tid", { $tid: teamId });
    run("DELETE FROM team_tasks WHERE team_id = $tid", { $tid: teamId });
    run("DELETE FROM team_members WHERE team_id = $tid", { $tid: teamId });
    run("DELETE FROM teams WHERE id = $id", { $id: teamId });
  });
}
