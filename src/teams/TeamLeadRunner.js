/**
 * TeamLeadRunner - project team orchestration (ClawTeam pattern).
 *
 * Architecture: Main Agent → Team Lead (sub-agent) → Workers (sub-agents)
 *
 * Key behaviors (matching ClawTeam):
 * - Lead polls worker status every 30s via waitForWorkers (ClawTeam: 5s poll)
 * - Worker sessions persist - re-assigned workers get full history
 * - Workers submit plans → lead approves before execution
 * - All state in SQLite (survives restart)
 * - Lead gets curated tools (19), not full profile dump
 * - Crew members can be workers (specialist tools)
 */

import { tool } from "ai";
import { z } from "zod";
import { spawnSubAgent } from "../agents/SubAgentManager.js";
import { buildContract } from "../agents/ContractBuilder.js";
import { getRegistry } from "../crew/PluginRegistry.js";
import { getSession, createSession, setMessages } from "../services/sessions.js";
import { compactForSession } from "../utils/msgText.js";
import { toolFunctions } from "../tools/index.js";
import * as store from "./TeamStore.js";
import tenantContext from "../tenants/TenantContext.js";

// ── Constants ───────────────────────────────────────────────────────────────

let POLL_INTERVAL_MS = parseInt(process.env.TEAM_POLL_INTERVAL_MS || "30000", 10);  // default 30s
const POLL_TIMEOUT_MS = 1_800_000; // 30 min max wait

/** Update poll interval at runtime (from UI/API) */
export function setPollInterval(ms) { POLL_INTERVAL_MS = Math.max(5000, Math.min(ms, 300000)); }

// Explicit lead tools - curated, not profile dump
const LEAD_TOOLS = [
  "readFile", "listDirectory", "glob", "grep", "gitTool",  // project awareness
  "readMemory", "writeMemory", "searchMemory",               // memory
  "webFetch", "webSearch",                                    // research
  "replyToUser",                                              // communication
  "useMCP", "useCrew",                                        // delegate to MCP servers + crew members
];

// ── Lead Crew Resolution ────────────────────────────────────────────────────

const LEAD_CREW_MAP = {
  coding: "project-lead-coding",
  software: "project-lead-coding",
  research: "project-lead-research",
  analysis: "project-lead-research",
};

function _resolveLeadCrew(projectType) {
  if (!projectType) return "project-lead-coding";
  return LEAD_CREW_MAP[projectType.toLowerCase()] || "project-lead-coding";
}

function _getLeadProfile(crewId) {
  try {
    const registry = getRegistry();
    const member = registry.crew.find(m => m.id === crewId && m.status === "loaded");
    if (member?.manifest?.profile) {
      return {
        systemPrompt: member.manifest.profile.systemPrompt || null,
        skills: member.manifest.skills || [],
      };
    }
  } catch {}
  return { systemPrompt: null, skills: [] };
}

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

// ── MCP + Crew context for lead ──────────────────────────────────────────────

async function _getMCPContext() {
  try {
    const { default: mcpManager } = await import("../mcp/MCPManager.js");
    const servers = mcpManager?.getConnectedServersInfo?.() || [];
    if (servers.length === 0) return "";
    const list = servers.map(s => `- ${s.name} (${s.toolCount} tools)`).join("\n");
    return `MCP Servers available (use useMCP to delegate):\n${list}`;
  } catch { return ""; }
}

function _getCrewContext() {
  try {
    const registry = getRegistry();
    const loaded = registry.crew?.filter(p => p.status === "loaded" && p.toolNames?.length > 0) || [];
    if (loaded.length === 0) return "";
    const list = loaded.map(p => `- ${p.id}: ${p.description || p.name} (${p.toolNames.join(", ")})`).join("\n");
    return `Crew members available (use useCrew to delegate):\n${list}`;
  } catch { return ""; }
}

// ── Team Lead Tools ─────────────────────────────────────────────────────────

function buildLeadTools(teamId, leadName) {

  const createWorker = tool({
    description: "Create and spawn a worker. Worker gets full contract + previous session if re-assigned.",
    inputSchema: z.object({
      name: z.string().describe("Worker name (unique within team)"),
      profile: z.string().optional().describe("Agent profile: coder|researcher|writer|analyst|frontend|tester|devops"),
      crew: z.string().optional().describe("Crew member ID (e.g. 'database-connector'). Use instead of profile."),
      task: z.string().describe("Full task description with complete context. Worker will execute directly from this - include: what to build, which files/paths, tech stack, API contracts, expected output. Worker does NOT plan - your description IS the plan."),
      skills: z.array(z.string()).optional().describe("Skill IDs to inject"),
      blockedBy: z.array(z.string()).optional().describe("Task IDs this depends on"),
    }),
    execute: async (params) => {
      try {
        if (!params.profile && !params.crew) return "Error: either profile or crew is required.";

        // Dedup: reject if worker with same name already exists in this team
        const existing = store.getMemberByName(teamId, params.name);
        if (existing) {
          return `Worker "${params.name}" already exists (status: ${existing.status}). Use a different name or check status.`;
        }

        // Cap: max 10 workers per team
        const allMembers = store.listMembers(teamId).filter(m => m.role === "worker");
        if (allMembers.length >= 10) {
          return `Error: team already has ${allMembers.length} workers (max 10). Use existing workers or disband and recreate.`;
        }

        const member = store.addMember({
          teamId, name: params.name, role: "worker",
          profile: params.crew || params.profile,
          skills: params.skills, instructions: params.task,
        });

        const task = store.createTask({
          teamId, title: `[${params.name}] ${params.task.slice(0, 100)}`,
          description: params.task, assignee: params.name, priority: 2,
          blockedBy: params.blockedBy,
        });

        if (params.blockedBy?.length > 0) {
          store.updateTask(task.id, { status: "blocked" });
        }

        // Build worker contract
        const workerContract = buildContract({
          task: params.task,
          context: `You are "${params.name}" on team "${teamId}". Your team lead assigned this task.`,
          constraints: "Your lead already planned the work. Execute the task directly - no re-planning needed.\n1. Read relevant files/context to understand what exists.\n2. Execute: create files, write code, run commands - whatever the task requires.\n3. Verify: run tests, read back files, check builds.\n4. Report via completeTask with what you built and verification results.\n5. Blockers → sendToLead.",
        });

        const workerTools = buildWorkerTools(teamId, params.name, task.id);

        // Load previous session if worker was re-assigned (context continuity)
        const historyMessages = _loadWorkerHistory(teamId, params.name);
        if (historyMessages.length > 0) {
          console.log(`[Team:${teamId}] Worker "${params.name}" loaded ${historyMessages.length} previous messages`);
        }

        store.updateMemberStatus(member.id, "working");
        store.updateTask(task.id, { status: "assigned", started_at: new Date().toISOString() });

        // Spawn worker
        const spawnPromise = params.crew
          ? import("../crew/CrewAgentRunner.js").then(({ runCrewAgent }) =>
              runCrewAgent(params.crew, workerContract, {})
            )
          : spawnSubAgent(workerContract, {
              profile: params.profile,
              skills: params.skills,
              aiToolOverrides: workerTools,
              historyMessages,
              depth: 2,
              returnFullResult: true,
            });

        spawnPromise.then(result => {
          store.updateMemberStatus(member.id, "done");
          // Save worker session for future re-assignment
          if (result?.messages) _saveWorkerSession(teamId, params.name, result.messages);
          console.log(`[Team:${teamId}] Worker "${params.name}" finished`);
        }).catch(err => {
          store.updateMemberStatus(member.id, "failed");
          console.log(`[Team:${teamId}] Worker "${params.name}" failed: ${err.message}`);
        });

        return `Worker "${params.name}" (${params.crew || params.profile}) spawned. Task: ${task.id}. ${params.blockedBy?.length ? "Blocked by: " + params.blockedBy.join(", ") : "Ready."}${historyMessages.length > 0 ? " (loaded previous context)" : ""}`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  });

  const assignTask = tool({
    description: "Create and assign a new task to an existing worker",
    inputSchema: z.object({
      workerName: z.string().describe("Worker name"),
      title: z.string().describe("Task title"),
      description: z.string().describe("Full task description"),
      priority: z.number().optional().describe("1=low, 2=medium, 3=high, 4=critical"),
      blockedBy: z.array(z.string()).optional(),
    }),
    execute: async (params) => {
      const task = store.createTask({
        teamId, title: params.title, description: params.description,
        assignee: params.workerName, priority: params.priority || 2,
        blockedBy: params.blockedBy,
      });
      store.sendMessage({ teamId, from: leadName, to: params.workerName, msgType: "message",
        content: `New task: "${params.title}" (${task.id}). ${params.description}` });
      return `Task "${params.title}" (${task.id}) assigned to ${params.workerName}.`;
    },
  });

  const waitForWorkers = tool({
    description: "Wait for workers to submit plans or complete tasks. Polls every 30 seconds. Use after creating workers.",
    inputSchema: z.object({
      waitFor: z.enum(["plans", "completion"]).describe("Wait for plan submissions or task completions"),
    }),
    execute: async (params) => {
      const startTime = Date.now();
      const waitingFor = params.waitFor;

      while (Date.now() - startTime < POLL_TIMEOUT_MS) {
        const tasks = store.listTasks(teamId);
        const unread = store.unreadCount(teamId, leadName);

        if (waitingFor === "plans") {
          // Check if any worker submitted a plan
          const planSubmitted = tasks.some(t => t.status === "plan_submitted");
          if (planSubmitted || unread > 0) {
            const submitted = tasks.filter(t => t.status === "plan_submitted");
            return `${submitted.length} plan(s) submitted. ${unread} unread message(s). Use reviewPlan to read them.`;
          }
        } else {
          // Check if all assigned tasks are completed
          const active = tasks.filter(t => ["assigned", "plan_submitted", "approved", "in_progress"].includes(t.status));
          const completed = tasks.filter(t => t.status === "completed");
          const failed = tasks.filter(t => t.status === "failed");
          if (active.length === 0 && (completed.length > 0 || failed.length > 0)) {
            return `All tasks done. Completed: ${completed.length}, Failed: ${failed.length}. Use checkStatus for details.`;
          }
          // Check for messages even while waiting
          if (unread > 0) {
            return `${active.length} task(s) still in progress. ${unread} unread message(s) - check them with reviewPlan.`;
          }
        }

        // Poll interval - actually wait (blocks the tool, not the model)
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      return `Timeout after ${POLL_TIMEOUT_MS / 60000} minutes. Use checkStatus to see current state.`;
    },
  });

  const reviewPlan = tool({
    description: "Read mailbox - plan submissions, status updates, messages from workers",
    inputSchema: z.object({}),
    execute: async () => {
      const msgs = store.readMessages(teamId, leadName);
      if (msgs.length === 0) return "No new messages.";
      return msgs.map(m => `[${m.msgType}] from "${m.from}"${m.requestId ? ` (ref: ${m.requestId})` : ""}:\n${m.content}`).join("\n\n---\n\n");
    },
  });

  const approvePlan = tool({
    description: "Approve or reject a worker's submitted plan",
    inputSchema: z.object({
      workerName: z.string(),
      requestId: z.string().describe("Plan request ID from reviewPlan"),
      approved: z.boolean(),
      feedback: z.string().optional(),
    }),
    execute: async (params) => {
      const msgType = params.approved ? "plan_approved" : "plan_rejected";
      store.sendMessage({ teamId, from: leadName, to: params.workerName, msgType,
        content: params.feedback || (params.approved ? "Plan approved. Proceed." : "Plan rejected. Revise."),
        requestId: params.requestId });
      if (params.approved) {
        const tasks = store.listTasks(teamId, { assignee: params.workerName });
        for (const t of tasks) {
          if (t.status === "plan_submitted" || t.status === "assigned") {
            store.updateTask(t.id, { status: "in_progress" });
          }
        }
      }
      return `Plan ${params.approved ? "approved" : "rejected"} for ${params.workerName}.`;
    },
  });

  const checkStatus = tool({
    description: "Full team status - members, tasks, messages",
    inputSchema: z.object({}),
    execute: async () => {
      const members = store.listMembers(teamId);
      const tasks = store.listTasks(teamId);
      const memberLines = members.filter(m => m.role !== "lead").map(m =>
        `  ${m.name} [${m.profile}] - ${m.status}`
      ).join("\n");
      const taskLines = tasks.map(t => {
        const blocked = t.blockedBy?.length ? ` (blocked by: ${t.blockedBy.join(", ")})` : "";
        return `  ${t.id} "${t.title}" - ${t.status} → ${t.assignee || "unassigned"}${blocked}`;
      }).join("\n");
      const unread = store.unreadCount(teamId, leadName);
      return `TEAM STATUS:\n\nWorkers:\n${memberLines || "  (none)"}\n\nTasks:\n${taskLines || "  (none)"}\n\nUnread: ${unread}`;
    },
  });

  const sendMsg = tool({
    description: "Message a worker ('*' for broadcast)",
    inputSchema: z.object({
      to: z.string(), message: z.string(),
    }),
    execute: async (params) => {
      if (params.to === "*") {
        store.broadcastMessage({ teamId, from: leadName, content: params.message });
        return "Broadcast sent.";
      }
      store.sendMessage({ teamId, from: leadName, to: params.to, msgType: "message", content: params.message });
      return `Sent to ${params.to}.`;
    },
  });

  const suggestFeature = tool({
    description: "Suggest scope change to main agent (don't wait - continue current work)",
    inputSchema: z.object({
      title: z.string(), description: z.string(), impact: z.string().optional(),
    }),
    execute: async (params) => {
      store.sendMessage({ teamId, from: leadName, to: "main-agent", msgType: "feature_suggestion",
        content: `Feature: ${params.title}\n${params.description}${params.impact ? "\nImpact: " + params.impact : ""}` });
      return `Feature "${params.title}" suggested. Continue working.`;
    },
  });

  const completeTeam = tool({
    description: "All tasks done - report final results to main agent",
    inputSchema: z.object({
      summary: z.string().describe("What was accomplished"),
    }),
    execute: async (params) => {
      store.updateTeamStatus(teamId, "completed");
      store.broadcastMessage({ teamId, from: leadName, msgType: "shutdown_request", content: "Team completed." });
      return params.summary;
    },
  });

  return { createWorker, assignTask, waitForWorkers, reviewPlan, approvePlan, checkStatus, sendMessage: sendMsg, suggestFeature, completeTeam };
}

// ── Worker Tools ────────────────────────────────────────────────────────────

function buildWorkerTools(teamId, workerName, taskId) {
  const submitPlan = tool({
    description: "Submit your execution plan to lead. REQUIRED before starting work.",
    inputSchema: z.object({
      plan: z.string().describe("Your plan - what you'll do, in what order, what tools"),
    }),
    execute: async (params) => {
      store.updateTask(taskId, { plan: params.plan, status: "plan_submitted" });
      store.sendMessage({ teamId, from: workerName, to: "lead", msgType: "plan_request",
        content: params.plan, requestId: `plan-${taskId}` });
      return "Plan submitted. Proceed with execution now.";
    },
  });

  const readMail = tool({
    description: "Check mailbox for messages from lead (approvals, feedback, instructions)",
    inputSchema: z.object({}),
    execute: async () => {
      const msgs = store.readMessages(teamId, workerName);
      if (msgs.length === 0) return "No new messages.";
      return msgs.map(m => `[${m.msgType}] from ${m.from}: ${m.content}`).join("\n\n");
    },
  });

  const completeTask = tool({
    description: "Mark task as completed",
    inputSchema: z.object({
      result: z.string().describe("What you accomplished"),
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
    description: "Message the lead (questions, blockers, updates)",
    inputSchema: z.object({ message: z.string() }),
    execute: async (params) => {
      store.sendMessage({ teamId, from: workerName, to: "lead", msgType: "message", content: params.message });
      return "Sent to lead.";
    },
  });

  return { submitPlan, readMail, completeTask, sendToLead };
}

// ── Run Team ────────────────────────────────────────────────────────────────

export async function runTeam({ name, leadContract, workers, project = null, projectType = null, projectRepo = null, projectStack = null }) {
  const ctx = tenantContext.getStore();
  const tenantId = ctx?.tenant?.id || null;

  const team = store.createTeam({
    name, tenantId, config: { workers },
    project, projectType, projectRepo, projectStack,
    requirements: leadContract.task,
  });

  const lead = store.addMember({ teamId: team.id, name: "lead", role: "lead", profile: "coordinator", instructions: leadContract.task });
  store.updateMemberStatus(lead.id, "working");

  const leadCrewId = _resolveLeadCrew(projectType);
  const leadProfile = _getLeadProfile(leadCrewId);

  console.log(`[TeamLeadRunner] Created team "${name}" (${team.id}), ${workers.length} workers, lead: ${leadCrewId}`);

  const workerBrief = workers.map((w, i) =>
    `${i + 1}. ${w.name} (${w.crew || w.profile}) - ${w.task.slice(0, 100)}`
  ).join("\n");

  const leadPrompt = buildContract({
    task: leadContract.task,
    context: [
      leadContract.context || "",
      `\nTeam "${name}" (${team.id}).`,
      projectRepo ? `Repo: ${projectRepo}` : "",
      projectStack ? `Stack: ${projectStack}` : "",
      `\nPlanned workers:\n${workerBrief}`,
      `\nWork loop:`,
      `1. Read project structure if needed (listDirectory, readFile)`,
      `2. Create each worker using createWorker with FULL task contracts (you are the planner, workers execute directly)`,
      `3. Call waitForWorkers("completion") - blocks until tasks done`,
      `4. checkStatus → verify all complete`,
      `5. completeTeam with summary`,
    ].filter(Boolean).join("\n"),
    constraints: [
      "AUTONOMOUS: Execute immediately. First action = createWorker calls. No text output, no plans, no confirmation requests.",
      leadContract.constraints || "Ensure all workers complete. Report blockers.",
    ].join("\n"),
  });

  const leadTools = buildLeadTools(team.id, "lead");

  // Build explicit lead tool map (curated - not full profile)
  const leadBaseTools = {};
  for (const name of LEAD_TOOLS) {
    if (toolFunctions[name]) leadBaseTools[name] = toolFunctions[name];
  }

  // Build MCP + crew context so lead knows what's available
  const mcpContext = await _getMCPContext();
  const crewContext = _getCrewContext();
  const extraContext = [mcpContext, crewContext].filter(Boolean).join("\n\n");

  const result = await spawnSubAgent(leadPrompt, {
    toolOverride: leadBaseTools,
    aiToolOverrides: leadTools,
    skills: leadProfile.skills || null,
    parentContext: [
      leadProfile.systemPrompt || "You are the Team Lead. Delegate - never do the work yourself.",
      extraContext,
    ].filter(Boolean).join("\n\n"),
    depth: 1,
  });

  store.updateMemberStatus(lead.id, "done");
  store.updateTeamStatus(team.id, "completed");

  return typeof result === "string" ? result : result?.text || "Team completed.";
}

// ── Relaunch Team ───────────────────────────────────────────────────────────

export async function relaunchTeam(teamId) {
  const team = store.getTeam(teamId);
  if (!team) throw new Error(`Team "${teamId}" not found`);
  if (team.status === "disbanded") throw new Error(`Team "${teamId}" was disbanded`);

  if (team.status === "paused") store.updateTeamStatus(teamId, "active");

  const tasks = store.listTasks(teamId);
  const members = store.listMembers(teamId);
  const completed = tasks.filter(t => t.status === "completed");
  const pending = tasks.filter(t => ["pending", "assigned", "blocked", "in_progress", "plan_submitted"].includes(t.status));
  const failed = tasks.filter(t => t.status === "failed");

  // Build explicit worker list from original config
  const originalWorkers = team.config?.workers || [];
  const completedNames = new Set(
    completed.map(t => t.assignee).filter(Boolean)
  );
  const workersToCreate = originalWorkers.filter(w => !completedNames.has(w.name));

  const workerInstructions = workersToCreate.length > 0
    ? `\nCreate EXACTLY these workers (use these exact names and profiles):\n${workersToCreate.map((w, i) =>
        `${i + 1}. name: "${w.name}", profile: "${w.crew || w.profile}", task: "${w.task}"`
      ).join("\n")}\n\nDo NOT create any other workers. Do NOT rename them.`
    : "\nAll workers completed. Verify results and call completeTeam.";

  const stateContext = [
    `RE-LAUNCHING project "${team.project || team.name}" (${teamId}).`,
    completed.length > 0 ? `Completed: ${completed.length}\n${completed.map(t => `  ✅ "${t.title}" → ${(t.result || "done").slice(0, 80)}`).join("\n")}` : "",
    failed.length > 0 ? `Failed: ${failed.length}\n${failed.map(t => `  ❌ "${t.title}"`).join("\n")}` : "",
    workerInstructions,
    team.requirements ? `\nRequirements: ${team.requirements.slice(0, 500)}` : "",
    team.projectRepo ? `Repo: ${team.projectRepo}` : "",
    team.projectStack ? `Stack: ${team.projectStack}` : "",
  ].filter(Boolean).join("\n");

  const leadPrompt = buildContract({
    task: `Resume project "${team.project || team.name}". Review state, continue to completion.`,
    context: stateContext,
    constraints: "AUTONOMOUS: Execute immediately. First action = createWorker calls for incomplete tasks. No text output, no plans, no confirmation requests.\nRe-create workers only for incomplete tasks. Workers will have their previous context.",
  });

  const leadCrewId = _resolveLeadCrew(team.projectType);
  const leadProfile = _getLeadProfile(leadCrewId);
  const leadTools = buildLeadTools(teamId, "lead");

  const leadBaseTools = {};
  for (const name of LEAD_TOOLS) {
    if (toolFunctions[name]) leadBaseTools[name] = toolFunctions[name];
  }

  console.log(`[TeamLeadRunner] Re-launching "${team.name}" (${teamId}) - ${completed.length} done, ${pending.length} pending`);

  const mcpCtx = await _getMCPContext();
  const crewCtx = _getCrewContext();
  const extraCtx = [mcpCtx, crewCtx].filter(Boolean).join("\n\n");

  const result = await spawnSubAgent(leadPrompt, {
    toolOverride: leadBaseTools,
    aiToolOverrides: leadTools,
    skills: leadProfile.skills || null,
    parentContext: [
      leadProfile.systemPrompt || "You are the Team Lead resuming a project.",
      extraCtx,
    ].filter(Boolean).join("\n\n"),
    depth: 1,
  });

  return typeof result === "string" ? result : result?.text || "Team resumed.";
}
