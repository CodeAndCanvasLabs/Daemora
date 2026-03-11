/**
 * TeamManager — creates and manages agent teams with shared task lists and messaging.
 *
 * Each team has:
 *   - A Mailbox for inter-agent messaging
 *   - A TeamTaskList for shared work with claim/lock/dependency mechanics
 *   - Teammates: registered agents that can be spawned and coordinated
 *
 * Teammates are spawned as sub-agents via SubAgentManager, with an external steerQueue
 * so TeamManager can inject mail/steering messages into running agents.
 *
 * Per-tenant isolation via TenantContext.
 * Max 5 teams, max 10 teammates per team.
 * Disbanded teams garbage collected after 30 min.
 */

import { v4 as uuidv4 } from "uuid";
import Mailbox from "./Mailbox.js";
import TeamTaskList from "./TeamTaskList.js";
import { spawnSubAgent } from "./SubAgentManager.js";
import tenantContext from "../tenants/TenantContext.js";
import eventBus from "../core/EventBus.js";

const MAX_TEAMS = 5;
const MAX_TEAMMATES = 10;
const GC_INTERVAL_MS = 30 * 60 * 1000; // 30 min

/** Map<teamId, TeamRecord> */
const teams = new Map();

// ── Garbage collection for disbanded teams ──────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, team] of teams.entries()) {
    if (team.disbanded && now - team.disbandedAt > GC_INTERVAL_MS) {
      teams.delete(id);
    }
  }
}, GC_INTERVAL_MS);

// ── Tenant scoping ──────────────────────────────────────────────────────────
function _getTenantId() {
  const store = tenantContext.getStore();
  return store?.tenant?.id || "__global__";
}

function _getTeam(teamId) {
  const team = teams.get(teamId);
  if (!team) throw new Error(`Team "${teamId}" not found`);
  if (team.disbanded) throw new Error(`Team "${teamId}" has been disbanded`);
  if (team.tenantId !== _getTenantId()) throw new Error(`Team "${teamId}" belongs to a different tenant`);
  return team;
}

function _countActiveTeams() {
  const tid = _getTenantId();
  let count = 0;
  for (const t of teams.values()) {
    if (!t.disbanded && t.tenantId === tid) count++;
  }
  return count;
}

// ── Teammate prompt builder ─────────────────────────────────────────────────

function _buildTeammatePrompt(team, teammate) {
  const T = team.id;
  const M = teammate.id;
  return `# Team Member — ${teammate.profile || "general"}

Team: "${team.name}" | ID: ${T} | You: ${M}
${teammate.instructions || "Complete assigned tasks."}

## Work Loop (repeat until no claimable tasks)
1. teamTask("claimable", '{"teamId":"${T}"}') → find available work
2. teamTask("claim", '{"teamId":"${T}","taskId":"<id>","teammateId":"${M}"}') → lock it
3. Execute — use tools, follow skills if they apply, chain calls until fully done. Read before editing. Verify after. Handle errors yourself.
4. teamTask("complete", '{"teamId":"${T}","taskId":"<id>","teammateId":"${M}","result":"brief summary"}') → mark done
5. teamTask("readMail", '{"teamId":"${T}","recipientId":"${M}"}') → check for messages
6. Go to 1.

## Communication
- teamTask("sendMessage", '{"teamId":"${T}","to":"<mateId>","message":"..."}') → direct message
- teamTask("broadcast", '{"teamId":"${T}","message":"..."}') → message all teammates
- teamTask("status", '{"teamId":"${T}"}') → see team progress

## Rules
- You are autonomous. No user. No confirmation. Execute directly.
- Never stop after planning. Plan → execute immediately.
- Claim before working. Complete or fail every claimed task.
- Do NOT mark complete until the task is actually done. Never complete with "in progress" or "will follow up".
- Progress updates → replyToUser(), then keep working. Never use it as a substitute for finishing.
- Be thorough — if the task says "all", do ALL of them.
- Stuck on a blocker → message the lead before marking as failed.
- Verbose output (reports, code, data) → save to files. Brief summary → return.`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new team.
 * @param {string} name - Team name
 * @param {string} [leadTaskId] - Parent task ID for kill propagation
 * @returns {{teamId: string, name: string}}
 */
export function createTeam(name, leadTaskId = null) {
  if (_countActiveTeams() >= MAX_TEAMS) {
    throw new Error(`Maximum ${MAX_TEAMS} active teams per tenant. Disband one first.`);
  }
  const teamId = uuidv4().slice(0, 8);
  const team = {
    id: teamId,
    name,
    tenantId: _getTenantId(),
    leadTaskId,
    mailbox: new Mailbox(),
    taskList: new TeamTaskList(),
    teammates: new Map(),     // Map<teammateId, {id, profile, instructions, status, steerQueue, promise}>
    createdAt: Date.now(),
    disbanded: false,
    disbandedAt: null,
  };
  teams.set(teamId, team);
  eventBus.emitEvent("team:created", { teamId, name, tenantId: team.tenantId });
  console.log(`[TeamManager] Created team "${name}" (${teamId})`);
  return { teamId, name };
}

/**
 * Register a teammate (does not spawn yet).
 * @param {string} teamId
 * @param {object} opts
 * @param {string} [opts.id] - Custom teammate ID (auto-generated if omitted)
 * @param {string} [opts.profile] - Agent profile: coder|researcher|writer|analyst
 * @param {string} [opts.instructions] - Custom instructions for this teammate
 * @returns {{teammateId: string, teamId: string}}
 */
export function addTeammate(teamId, { id, profile, instructions } = {}) {
  const team = _getTeam(teamId);
  if (team.teammates.size >= MAX_TEAMMATES) {
    throw new Error(`Maximum ${MAX_TEAMMATES} teammates per team.`);
  }
  const teammateId = id || `mate-${uuidv4().slice(0, 6)}`;
  if (team.teammates.has(teammateId)) {
    throw new Error(`Teammate "${teammateId}" already exists in team "${teamId}".`);
  }
  const teammate = {
    id: teammateId,
    profile: profile || null,
    instructions: instructions || "",
    status: "idle",           // idle | running | finished | error
    steerQueue: [],           // external steerQueue — TeamManager can push messages here
    promise: null,
    result: null,
    error: null,
    spawnedAt: null,
  };
  team.teammates.set(teammateId, teammate);
  eventBus.emitEvent("team:teammate_added", { teamId, teammateId, profile });
  console.log(`[TeamManager] Added teammate "${teammateId}" [${profile || "general"}] to team "${team.name}"`);
  return { teammateId, teamId };
}

/**
 * Spawn a registered teammate as a sub-agent (fire-and-forget).
 * @param {string} teamId
 * @param {string} teammateId
 * @param {object} [opts]
 * @param {string} [opts.context] - Additional context for the teammate
 * @returns {{teammateId: string, status: string}}
 */
export function spawnTeammate(teamId, teammateId, { context } = {}) {
  const team = _getTeam(teamId);
  const teammate = team.teammates.get(teammateId);
  if (!teammate) throw new Error(`Teammate "${teammateId}" not found in team "${teamId}"`);
  if (teammate.status === "running") throw new Error(`Teammate "${teammateId}" is already running`);

  teammate.status = "running";
  teammate.spawnedAt = Date.now();
  console.log(`[Team:${team.name}] Spawning teammate "${teammateId}" (profile: ${teammate.profile || "default"})`);

  const prompt = _buildTeammatePrompt(team, teammate);
  const parentContext = context ? `${prompt}\n\n## Additional Context\n${context}` : prompt;

  // Fire-and-forget — track completion via promise
  teammate.promise = spawnSubAgent(
    `[Team "${team.name}"] ${teammate.instructions || "Complete team tasks."}`,
    {
      profile: teammate.profile,
      parentTaskId: team.leadTaskId,
      parentContext,
      steerQueue: teammate.steerQueue,   // external steerQueue — allows message injection
      extraTools: ["teamTask"],
    }
  ).then((result) => {
    teammate.status = "finished";
    teammate.result = typeof result === "string" ? result : result?.text || "";
    console.log(`[TeamManager] Teammate "${teammateId}" finished in team "${team.name}"`);
    eventBus.emitEvent("team:teammate_finished", { teamId, teammateId, resultPreview: teammate.result.slice(0, 200) });
  }).catch((err) => {
    teammate.status = "error";
    teammate.error = err.message;
    console.log(`[TeamManager] Teammate "${teammateId}" errored in team "${team.name}": ${err.message}`);
    eventBus.emitEvent("team:teammate_error", { teamId, teammateId, error: err.message });
  });

  return { teammateId, status: "running" };
}

/**
 * Spawn all idle teammates.
 * @param {string} teamId
 * @param {object} [opts]
 * @param {string} [opts.context]
 * @returns {Array<{teammateId: string, status: string}>}
 */
export function spawnAll(teamId, { context } = {}) {
  const team = _getTeam(teamId);
  const results = [];
  for (const [id, mate] of team.teammates.entries()) {
    if (mate.status === "idle") {
      results.push(spawnTeammate(teamId, id, { context }));
    }
  }
  return results;
}

/**
 * Send a direct message to a teammate via mailbox + steerQueue injection.
 * @param {string} teamId
 * @param {string} teammateId - Recipient
 * @param {string} message
 * @param {string} [fromId="lead"] - Sender
 */
export function messageTeammate(teamId, teammateId, message, fromId = "lead") {
  const team = _getTeam(teamId);
  const mate = team.teammates.get(teammateId);
  if (!mate) throw new Error(`Teammate "${teammateId}" not found in team "${teamId}"`);

  // Store in mailbox for persistence
  team.mailbox.send(fromId, teammateId, message);

  // Inject into steerQueue for immediate delivery if running
  if (mate.status === "running" && mate.steerQueue) {
    mate.steerQueue.push(`[Team Message from ${fromId}]: ${message}`);
  }

  return { sent: true, to: teammateId, from: fromId };
}

/**
 * Broadcast a message to all teammates.
 * @param {string} teamId
 * @param {string} message
 * @param {string} [fromId="lead"]
 */
export function broadcastToTeam(teamId, message, fromId = "lead") {
  const team = _getTeam(teamId);

  // Store as broadcast in mailbox
  team.mailbox.send(fromId, "*", message);

  // Inject into all running teammates' steerQueues
  for (const mate of team.teammates.values()) {
    if (mate.status === "running" && mate.steerQueue && mate.id !== fromId) {
      mate.steerQueue.push(`[Team Broadcast from ${fromId}]: ${message}`);
    }
  }

  return { broadcast: true, from: fromId, recipients: team.teammates.size };
}

/**
 * Get full team status.
 * @param {string} teamId
 */
export function getTeamStatus(teamId) {
  const team = _getTeam(teamId);
  const teammates = [...team.teammates.values()].map((m) => ({
    id: m.id,
    profile: m.profile,
    status: m.status,
    spawnedAt: m.spawnedAt ? new Date(m.spawnedAt).toISOString() : null,
    hasResult: !!m.result,
    hasError: !!m.error,
  }));
  return {
    teamId: team.id,
    name: team.name,
    createdAt: new Date(team.createdAt).toISOString(),
    teammates,
    tasks: team.taskList.summary(),
    messages: {
      total: team.mailbox.count(),
    },
  };
}

/**
 * Disband a team — kills all running teammates, marks as disbanded.
 * @param {string} teamId
 */
export function disbandTeam(teamId) {
  const team = _getTeam(teamId);

  // Kill all running teammates by aborting their steerQueues with a kill signal
  for (const mate of team.teammates.values()) {
    if (mate.status === "running" && mate.steerQueue) {
      mate.steerQueue.push("[SYSTEM] Team disbanded. Stop all work and finalize immediately.");
    }
  }

  team.disbanded = true;
  team.disbandedAt = Date.now();
  eventBus.emitEvent("team:disbanded", { teamId, name: team.name });
  console.log(`[TeamManager] Disbanded team "${team.name}" (${teamId})`);
  return { disbanded: true, teamId, name: team.name };
}

// ── Direct access to team internals (used by teamTool) ─────────────────────

/**
 * Get a team's Mailbox instance.
 * @param {string} teamId
 * @returns {Mailbox}
 */
export function getMailbox(teamId) {
  return _getTeam(teamId).mailbox;
}

/**
 * Get a team's TeamTaskList instance.
 * @param {string} teamId
 * @returns {TeamTaskList}
 */
export function getTaskList(teamId) {
  return _getTeam(teamId).taskList;
}
