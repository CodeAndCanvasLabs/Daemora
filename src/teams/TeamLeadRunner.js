/**
 * TeamLeadRunner - Deterministic team orchestration (ClawTeam pattern).
 *
 * Architecture: Lead = CODE (not AI). Workers = AI sub-agents.
 *
 * The lead is a JavaScript loop that:
 * 1. Creates all workers (spawns sub-agents) - deterministic
 * 2. Waits for completion (Promise.allSettled) - deterministic
 * 3. Handles dependencies (phase-based execution) - deterministic
 * 4. Collects results and updates state - deterministic
 *
 * AI is ONLY in the workers doing actual work. Orchestration is pure code.
 * All state in SQLite (survives restart).
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

const POLL_INTERVAL_MS = 5000; // 5s status check (ClawTeam: 5s)
const TEAM_TIMEOUT_MS = 1_800_000; // 30 min max

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

// ── Worker Tools (minimal - just reporting) ─────────────────────────────────

function _buildWorkerTools(teamId, workerName, taskId) {
  const completeTask = tool({
    description: "Mark your task as completed with a summary of what you built",
    inputSchema: z.object({
      result: z.string().describe("What you accomplished - files created, endpoints built, etc."),
    }),
    execute: async (params) => {
      store.updateTask(taskId, { status: "completed", result: params.result, completed_at: new Date().toISOString() });
      store.resolveDependencies(teamId, taskId);
      store.sendMessage({ teamId, from: workerName, to: "lead", msgType: "status_update",
        content: `Task completed: ${params.result}` });
      return "Done. Lead notified.";
    },
  });

  const sendToLead = tool({
    description: "Report a blocker, question, or progress update to the lead",
    inputSchema: z.object({ message: z.string() }),
    execute: async (params) => {
      store.sendMessage({ teamId, from: workerName, to: "lead", msgType: "message", content: params.message });
      return "Logged.";
    },
  });

  return { completeTask, sendToLead };
}

// ── Spawn a single worker ───────────────────────────────────────────────────

async function _spawnWorker(teamId, worker, member, task) {
  const contract = buildContract({
    task: worker.task,
    context: `You are "${worker.name}" on team "${teamId}". Execute this task fully and autonomously.`,
    constraints: "Execute the task directly. Do not ask for confirmation.\n1. Read relevant files/context to understand what exists.\n2. Execute: create files, write code, run commands.\n3. Verify your work: run tests, read back files, check builds.\n4. Call completeTask with a summary of what you built.\n5. Blockers → sendToLead.",
  });

  const workerTools = _buildWorkerTools(teamId, worker.name, task.id);
  const historyMessages = _loadWorkerHistory(teamId, worker.name);

  if (historyMessages.length > 0) {
    console.log(`[Team:${teamId}] Worker "${worker.name}" loaded ${historyMessages.length} previous messages`);
  }

  store.updateMemberStatus(member.id, "working");
  store.updateTask(task.id, { status: "assigned", started_at: new Date().toISOString() });

  // Spawn worker as sub-agent
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

  // Save session for future re-assignment
  if (result?.messages) _saveWorkerSession(teamId, worker.name, result.messages);

  return result;
}

// ── Deterministic Orchestration Loop ────────────────────────────────────────

/**
 * Phase-based execution:
 * 1. Spawn all workers that are not blocked
 * 2. Wait for them to finish (Promise.allSettled)
 * 3. Process results, resolve dependencies
 * 4. Repeat for newly unblocked workers
 * 5. Stop when all done or deadlocked
 */
async function _orchestrate(teamId, workerDefs) {
  // Track state for each worker
  const state = workerDefs.map(w => ({
    worker: w,
    member: null,
    task: null,
    done: false,
    result: null,
    error: null,
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
    const blockedByWorkers = ws.worker.blockedByWorkers || ws.worker.blockedBy || [];
    if (blockedByWorkers.length > 0) {
      const blockedByTaskIds = [];
      for (const depName of blockedByWorkers) {
        const dep = state.find(s => s.worker.name === depName);
        if (dep) blockedByTaskIds.push(dep.task.id);
      }
      if (blockedByTaskIds.length > 0) {
        store.updateTask(ws.task.id, { status: "blocked", blocked_by: JSON.stringify(blockedByTaskIds) });
      }
    }
  }

  const startTime = Date.now();

  // Phase loop: spawn ready → wait → resolve deps → repeat
  while (true) {
    // Timeout check
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
      // Check if we're done or deadlocked
      const allDone = state.every(ws => ws.done);
      const anyRunning = state.some(ws => ws._promise && !ws.done);
      if (allDone || !anyRunning) break;

      // Workers still running, wait a bit
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    // Spawn all ready workers in parallel
    console.log(`[Team:${teamId}] Spawning ${ready.length} worker(s): ${ready.map(ws => ws.worker.name).join(", ")}`);

    for (const ws of ready) {
      ws._promise = _spawnWorker(teamId, ws.worker, ws.member, ws.task)
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

  // Wait for any remaining promises
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
      const result = taskRow?.result || ws.result?.text || "Done";
      lines.push(`  - ${ws.worker.name}: ${result.slice(0, 200)}`);
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

  // Collect worker messages
  const messages = store.readMessages(state[0]?.task?.teamId || "", "lead");
  if (messages.length > 0) {
    lines.push(`\nWorker messages (${messages.length}):`);
    for (const m of messages.slice(0, 10)) {
      lines.push(`  [${m.from}] ${m.content?.slice(0, 150)}`);
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

  console.log(`[TeamLeadRunner] Created team "${name}" (${team.id}), ${workers.length} worker(s)`);
  console.log(`[TeamLeadRunner] Workers: ${workers.map(w => `${w.name} (${w.crew || w.profile})`).join(", ")}`);

  // Deterministic orchestration - no AI lead
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

  // Find incomplete workers from original config
  const tasks = store.listTasks(teamId);
  const completedNames = new Set(
    tasks.filter(t => t.status === "completed").map(t => t.assignee).filter(Boolean)
  );

  const originalWorkers = team.config?.workers || [];
  const workersToRun = originalWorkers.filter(w => !completedNames.has(w.name));

  if (workersToRun.length === 0) {
    store.updateTeamStatus(teamId, "completed");
    return `Team "${team.name}" already completed - all workers finished.`;
  }

  console.log(`[TeamLeadRunner] Re-launching "${team.name}" (${teamId}) - ${completedNames.size} done, ${workersToRun.length} remaining`);

  // Run the remaining workers through the same deterministic loop
  const state = await _orchestrate(teamId, workersToRun);

  const allDone = state.every(ws => ws.done);
  const anyFailed = state.some(ws => ws.error);
  store.updateTeamStatus(teamId, allDone && !anyFailed ? "completed" : "completed");

  return _buildSummary(team.name, state);
}
