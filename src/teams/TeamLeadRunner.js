/**
 * TeamLeadRunner - Deterministic swarm orchestration.
 *
 * Pattern: Code orchestrator + AI workers + shared context (swarm-style).
 *
 * Key design (from OpenAI Swarm + CrewAI + ClawTeam):
 * - Lead = deterministic code loop, never an AI model
 * - Workers = AI sub-agents doing actual work
 * - Shared context: completed worker results flow into dependent workers
 * - Filesystem IS shared state: workers read each other's files
 * - Phase-based: spawn ready workers, wait, pass results forward, repeat
 *
 * Flow:
 * 1. Create all tasks/members in DB
 * 2. Resolve dependency graph (blockedByWorkers → task IDs)
 * 3. Spawn all non-blocked workers with full context
 * 4. When worker completes → store structured result → unblock dependents
 * 5. Spawn newly ready workers WITH completed dependency results injected
 * 6. Repeat until all done
 * 7. Return summary
 */

import { tool } from "ai";
import { z } from "zod";
import { spawnSubAgent } from "../agents/SubAgentManager.js";
import { buildContract } from "../agents/ContractBuilder.js";
import { getSession, createSession, setMessages } from "../services/sessions.js";
import { compactForSession } from "../utils/msgText.js";
import * as store from "./TeamStore.js";
import tenantContext from "../tenants/TenantContext.js";

// ── Constants ───────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5000;
const TEAM_TIMEOUT_MS = 1_800_000; // 30 min

// ── Worker Session Persistence ──────────────────────────────────────────────

function _workerSessionId(teamId, workerName) {
  return `team:${teamId}--worker:${workerName}`;
}

function _loadWorkerHistory(teamId, workerName) {
  const sessionId = _workerSessionId(teamId, workerName);
  const session = getSession(sessionId);
  if (session && session.messages?.length > 0) {
    return session.messages.map(m => ({ role: m.role, content: m.content }));
  }
  return [];
}

function _saveWorkerSession(teamId, workerName, messages) {
  if (!messages || messages.length === 0) return;
  const sessionId = _workerSessionId(teamId, workerName);
  let session = getSession(sessionId);
  if (!session) session = createSession(sessionId);
  const capped = messages.length > 100 ? messages.slice(-100) : messages;
  setMessages(sessionId, compactForSession(capped));
}

// ── Worker Tools ────────────────────────────────────────────────────────────

function _buildWorkerTools(teamId, workerName, taskId) {
  const completeTask = tool({
    description: "Mark your task as completed. Include structured details so dependent workers know what you built.",
    inputSchema: z.object({
      result: z.string().describe("Summary of what you accomplished"),
      filesCreated: z.array(z.string()).optional().describe("List of file paths you created or modified"),
      endpoints: z.array(z.string()).optional().describe("API endpoints you built (e.g. 'GET /api/todos')"),
      port: z.number().optional().describe("Port number your service runs on"),
      notes: z.string().optional().describe("Anything the next worker needs to know"),
    }),
    execute: async (params) => {
      // Store structured result as JSON
      const structured = {
        summary: params.result,
        filesCreated: params.filesCreated || [],
        endpoints: params.endpoints || [],
        port: params.port || null,
        notes: params.notes || null,
      };
      store.updateTask(taskId, {
        status: "completed",
        result: JSON.stringify(structured),
        completed_at: new Date().toISOString(),
      });
      store.resolveDependencies(teamId, taskId);
      store.sendMessage({ teamId, from: workerName, to: "lead", msgType: "status_update",
        content: `Task completed: ${params.result}` });
      return "Done. Lead notified.";
    },
  });

  const sendToLead = tool({
    description: "Report a blocker, question, or progress update",
    inputSchema: z.object({ message: z.string() }),
    execute: async (params) => {
      store.sendMessage({ teamId, from: workerName, to: "lead", msgType: "message", content: params.message });
      return "Logged.";
    },
  });

  return { completeTask, sendToLead };
}

// ── Shared Context Builder (Swarm Pattern) ──────────────────────────────────

/**
 * Build context string from completed dependency results.
 * This is the swarm handoff — completed worker artifacts flow into dependent workers.
 */
function _buildDependencyContext(ws, allState) {
  const deps = ws.worker.blockedByWorkers || ws.worker.blockedBy || [];
  if (deps.length === 0) return "";

  const sections = [];
  for (const depName of deps) {
    const dep = allState.find(s => s.worker.name === depName);
    if (!dep || !dep.done || dep.error) continue;

    const taskRow = store.getTask(dep.task.id);
    if (!taskRow?.result) continue;

    // Parse structured result if JSON, otherwise use raw text
    let resultInfo;
    try {
      const parsed = JSON.parse(taskRow.result);
      const parts = [`"${depName}" completed: ${parsed.summary}`];
      if (parsed.filesCreated?.length) parts.push(`Files: ${parsed.filesCreated.join(", ")}`);
      if (parsed.endpoints?.length) parts.push(`Endpoints: ${parsed.endpoints.join(", ")}`);
      if (parsed.port) parts.push(`Port: ${parsed.port}`);
      if (parsed.notes) parts.push(`Notes: ${parsed.notes}`);
      resultInfo = parts.join("\n");
    } catch {
      resultInfo = `"${depName}" completed: ${taskRow.result}`;
    }

    sections.push(resultInfo);
  }

  if (sections.length === 0) return "";
  return `\n\n## Completed by other workers (use this context):\n${sections.join("\n\n")}`;
}

// ── Spawn a single worker ───────────────────────────────────────────────────

async function _spawnWorker(teamId, ws, allState) {
  const worker = ws.worker;
  const member = ws.member;
  const task = ws.task;

  // Build dependency context (swarm handoff)
  const depContext = _buildDependencyContext(ws, allState);

  const contract = buildContract({
    task: worker.task,
    context: [
      `You are "${worker.name}" on team "${teamId}". Execute this task fully and autonomously.`,
      depContext,
    ].filter(Boolean).join("\n"),
    constraints: "Execute the task directly. Do not ask for confirmation.\n1. Read relevant files/context to understand what exists.\n2. Execute: create files, write code, run commands.\n3. Verify your work: run tests, read back files, check builds.\n4. Call completeTask with structured details (files, endpoints, port) so dependent workers can use your output.\n5. Blockers → sendToLead.",
  });

  const workerTools = _buildWorkerTools(teamId, worker.name, task.id);
  const historyMessages = _loadWorkerHistory(teamId, worker.name);

  if (historyMessages.length > 0) {
    console.log(`[Team:${teamId}] Worker "${worker.name}" loaded ${historyMessages.length} previous messages`);
  }

  store.updateMemberStatus(member.id, "working");
  store.updateTask(task.id, { status: "assigned", started_at: new Date().toISOString() });

  const result = worker.crew
    ? await import("../crew/CrewAgentRunner.js").then(({ runCrewAgent }) =>
        runCrewAgent(worker.crew, contract, {})
      )
    : await spawnSubAgent(contract, {
        profile: worker.profile,
        skills: worker.skills,
        aiToolOverrides: workerTools,
        historyMessages,
        depth: 1,
        returnFullResult: true,
      });

  if (result?.messages) _saveWorkerSession(teamId, worker.name, result.messages);
  return result;
}

// ── Deterministic Orchestration Loop (Swarm) ────────────────────────────────

async function _orchestrate(teamId, workerDefs) {
  const state = workerDefs.map(w => ({
    worker: w,
    member: null,
    task: null,
    done: false,
    result: null,
    error: null,
    _promise: null,
  }));

  // Create all members and tasks upfront
  for (const ws of state) {
    ws.member = store.addMember({
      teamId, name: ws.worker.name, role: "worker",
      profile: ws.worker.crew || ws.worker.profile,
      skills: ws.worker.skills, instructions: ws.worker.task,
    });

    ws.task = store.createTask({
      teamId, title: `[${ws.worker.name}] ${ws.worker.task.slice(0, 100)}`,
      description: ws.worker.task, assignee: ws.worker.name, priority: 2,
    });
  }

  // Resolve blockedByWorkers → actual task IDs
  for (const ws of state) {
    const deps = ws.worker.blockedByWorkers || ws.worker.blockedBy || [];
    if (deps.length > 0) {
      const blockedByTaskIds = [];
      for (const depName of deps) {
        const dep = state.find(s => s.worker.name === depName);
        if (dep) blockedByTaskIds.push(dep.task.id);
      }
      if (blockedByTaskIds.length > 0) {
        store.updateTask(ws.task.id, { status: "blocked", blocked_by: JSON.stringify(blockedByTaskIds) });
      }
    }
  }

  const startTime = Date.now();

  // Phase loop: spawn ready → wait → pass results → spawn newly ready → repeat
  while (true) {
    if (Date.now() - startTime > TEAM_TIMEOUT_MS) {
      console.log(`[Team:${teamId}] Timeout after ${TEAM_TIMEOUT_MS / 60000} minutes`);
      break;
    }

    // Find workers ready to spawn (not done, not blocked, not already running)
    const ready = state.filter(ws => {
      if (ws.done || ws._promise) return false;
      const taskRow = store.getTask(ws.task.id);
      return taskRow && taskRow.status !== "blocked";
    });

    if (ready.length === 0) {
      const allDone = state.every(ws => ws.done);
      const anyRunning = state.some(ws => ws._promise && !ws.done);
      if (allDone || !anyRunning) break;
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    // Spawn all ready workers in parallel — each gets dependency results injected
    console.log(`[Team:${teamId}] Spawning ${ready.length} worker(s): ${ready.map(ws => ws.worker.name).join(", ")}`);

    for (const ws of ready) {
      ws._promise = _spawnWorker(teamId, ws, state)
        .then(result => {
          ws.done = true;
          ws.result = result;
          store.updateMemberStatus(ws.member.id, "done");
          // Task may already be marked completed by completeTask tool
          const taskRow = store.getTask(ws.task.id);
          if (taskRow && taskRow.status !== "completed") {
            store.updateTask(ws.task.id, {
              status: "completed",
              result: typeof result === "string" ? result : result?.text || "Done",
              completed_at: new Date().toISOString(),
            });
            store.resolveDependencies(teamId, ws.task.id);
          }
          console.log(`[Team:${teamId}] Worker "${ws.worker.name}" completed`);
        })
        .catch(err => {
          ws.done = true;
          ws.error = err;
          store.updateMemberStatus(ws.member.id, "failed");
          store.updateTask(ws.task.id, { status: "failed" });
          console.log(`[Team:${teamId}] Worker "${ws.worker.name}" failed: ${err.message}`);
        });
    }

    // Wait for at least one to finish before checking deps again
    const running = state.filter(ws => ws._promise && !ws.done);
    if (running.length > 0) {
      await Promise.race(running.map(ws => ws._promise));
    }
  }

  // Wait for any stragglers
  const remaining = state.filter(ws => ws._promise && !ws.done);
  if (remaining.length > 0) {
    await Promise.allSettled(remaining.map(ws => ws._promise));
  }

  return state;
}

// ── Build Summary ───────────────────────────────────────────────────────────

function _buildSummary(teamName, state) {
  const completed = state.filter(ws => ws.done && !ws.error);
  const failed = state.filter(ws => ws.done && ws.error);
  const blocked = state.filter(ws => !ws.done);

  const lines = [`Team "${teamName}" finished.`];

  if (completed.length > 0) {
    lines.push(`\nCompleted (${completed.length}):`);
    for (const ws of completed) {
      const taskRow = store.getTask(ws.task.id);
      let summary = "Done";
      if (taskRow?.result) {
        try {
          const parsed = JSON.parse(taskRow.result);
          summary = parsed.summary || taskRow.result;
        } catch {
          summary = taskRow.result;
        }
      }
      lines.push(`  - ${ws.worker.name}: ${summary.slice(0, 200)}`);
    }
  }

  if (failed.length > 0) {
    lines.push(`\nFailed (${failed.length}):`);
    for (const ws of failed) {
      lines.push(`  - ${ws.worker.name}: ${ws.error?.message || "Unknown error"}`);
    }
  }

  if (blocked.length > 0) {
    lines.push(`\nBlocked/Unfinished (${blocked.length}):`);
    for (const ws of blocked) {
      lines.push(`  - ${ws.worker.name}`);
    }
  }

  return lines.join("\n");
}

// ── Run Team (public) ───────────────────────────────────────────────────────

export async function runTeam({ name, leadContract, workers, project = null, projectType = null, projectRepo = null, projectStack = null }) {
  const ctx = tenantContext.getStore();
  const tenantId = ctx?.tenant?.id || null;

  const team = store.createTeam({
    name, tenantId, config: { workers },
    project, projectType, projectRepo, projectStack,
    requirements: leadContract.task,
  });

  const lead = store.addMember({ teamId: team.id, name: "lead", role: "lead", profile: "orchestrator", instructions: leadContract.task });
  store.updateMemberStatus(lead.id, "working");

  console.log(`[TeamLeadRunner] Team "${name}" (${team.id}) — ${workers.length} worker(s)`);
  console.log(`[TeamLeadRunner] Workers: ${workers.map(w => `${w.name} (${w.crew || w.profile})`).join(", ")}`);

  const state = await _orchestrate(team.id, workers);

  store.updateMemberStatus(lead.id, "done");
  const allDone = state.every(ws => ws.done);
  const anyFailed = state.some(ws => ws.error);
  store.updateTeamStatus(team.id, allDone && !anyFailed ? "completed" : "completed");

  const summary = _buildSummary(name, state);
  console.log(`[TeamLeadRunner] ${summary.split("\n")[0]}`);
  return summary;
}

// ── Relaunch Team (public) ──────────────────────────────────────────────────

export async function relaunchTeam(teamId) {
  const team = store.getTeam(teamId);
  if (!team) throw new Error(`Team "${teamId}" not found`);
  if (team.status === "disbanded") throw new Error(`Team "${teamId}" was disbanded`);

  if (team.status === "paused") store.updateTeamStatus(teamId, "active");

  const tasks = store.listTasks(teamId);
  const completedNames = new Set(
    tasks.filter(t => t.status === "completed").map(t => t.assignee).filter(Boolean)
  );

  const originalWorkers = team.config?.workers || [];
  const workersToRun = originalWorkers.filter(w => !completedNames.has(w.name));

  if (workersToRun.length === 0) {
    store.updateTeamStatus(teamId, "completed");
    return `Team "${team.name}" already completed.`;
  }

  console.log(`[TeamLeadRunner] Re-launching "${team.name}" (${teamId}) — ${completedNames.size} done, ${workersToRun.length} remaining`);

  const state = await _orchestrate(teamId, workersToRun);

  const allDone = state.every(ws => ws.done);
  const anyFailed = state.some(ws => ws.error);
  store.updateTeamStatus(teamId, allDone && !anyFailed ? "completed" : "completed");

  return _buildSummary(team.name, state);
}
