/**
 * TeamLeadRunner — spawns team lead sub-agent with management tools.
 *
 * Flow (ClawTeam pattern adapted for Daemora):
 * 1. Main agent calls teamTask("createTeam", {...})
 * 2. TeamLeadRunner creates team + lead member in SQLite
 * 3. Spawns Team Lead sub-agent with:
 *    - Management tools (createWorker, assignTask, reviewPlan, approvePlan, checkStatus, sendMessage, completeTeam)
 *    - Full contract from main agent (task, context, constraints)
 *    - Worker definitions (names, profiles, tasks)
 * 4. Team Lead creates workers, assigns tasks, reviews plans, reports back
 * 5. Workers receive full contracts with their assigned tasks
 *
 * Team Lead is a real sub-agent — it has its own tools, context, and decision-making.
 * Workers get full contracts too — they know what to do without guessing.
 */

import { tool } from "ai";
import { z } from "zod";
import { spawnSubAgent } from "../agents/SubAgentManager.js";
import { buildContract } from "../agents/ContractBuilder.js";
import * as store from "./TeamStore.js";
import tenantContext from "../tenants/TenantContext.js";

// ── Team Lead Tools (only the lead gets these) ──────────────────────────────

function buildLeadTools(teamId, leadName) {

  const createWorker = tool({
    description: "Create and spawn a worker sub-agent for this team",
    inputSchema: z.object({
      name: z.string().describe("Worker name (unique within team)"),
      profile: z.string().optional().describe("Agent profile: coder|researcher|writer|analyst|frontend|tester|devops|etc"),
      crew: z.string().optional().describe("Crew member ID to use as worker (e.g. 'database-connector'). Use instead of profile for specialist crew."),
      task: z.string().describe("Full task description — the worker's assignment. Be specific."),
      skills: z.array(z.string()).optional().describe("Skill IDs to inject (e.g. ['coding', 'debugging'])"),
      blockedBy: z.array(z.string()).optional().describe("Task IDs this worker's task depends on"),
    }),
    execute: async (params) => {
      try {
        if (!params.profile && !params.crew) return "Error: either profile or crew is required.";

        // Create member
        const member = store.addMember({
          teamId,
          name: params.name,
          role: "worker",
          profile: params.crew || params.profile,
          skills: params.skills,
          instructions: params.task,
        });

        // Create task assigned to this worker
        const task = store.createTask({
          teamId,
          title: `[${params.name}] ${params.task.slice(0, 100)}`,
          description: params.task,
          assignee: params.name,
          priority: 2,
          blockedBy: params.blockedBy,
        });

        // If blocked, set task status to blocked
        if (params.blockedBy?.length > 0) {
          store.updateTask(task.id, { status: "blocked" });
        }

        // Spawn worker sub-agent with full contract
        const workerContract = buildContract({
          task: params.task,
          context: `You are "${params.name}" on team "${teamId}". Your team lead assigned this task to you.`,
          constraints: [
            "Before starting work, submit your plan via teamWork('submitPlan', ...) and WAIT for approval.",
            "After plan is approved, execute it fully.",
            "Report completion via teamWork('completeTask', ...).",
            "Check mailbox regularly via teamWork('readMail', ...) for messages from the lead.",
          ].join("\n"),
        });

        const workerTools = buildWorkerTools(teamId, params.name, task.id);

        store.updateMemberStatus(member.id, "working");
        store.updateTask(task.id, { status: "assigned", started_at: new Date().toISOString() });

        // Spawn worker (fire-and-forget)
        const spawnPromise = params.crew
          ? // Crew-based worker: uses CrewAgentRunner (specialist tools from crew)
            import("../crew/CrewAgentRunner.js").then(({ runCrewAgent }) =>
              runCrewAgent(params.crew, workerContract, {})
            )
          : // Profile-based worker: uses SubAgentManager
            spawnSubAgent(workerContract, {
              profile: params.profile,
              skills: params.skills,
              aiToolOverrides: workerTools,
              depth: 2,
            });

        spawnPromise.then(result => {
          store.updateMemberStatus(member.id, "done");
          console.log(`[Team:${teamId}] Worker "${params.name}" finished`);
        }).catch(err => {
          store.updateMemberStatus(member.id, "failed");
          console.log(`[Team:${teamId}] Worker "${params.name}" failed: ${err.message}`);
        });

        const workerType = params.crew ? `crew:${params.crew}` : params.profile;
        return `Worker "${params.name}" (${workerType}) created and spawned. Task: ${task.id}. ${params.blockedBy?.length ? "Blocked by: " + params.blockedBy.join(", ") : "Ready to work."}`;
      } catch (err) {
        return `Error creating worker: ${err.message}`;
      }
    },
  });

  const assignTask = tool({
    description: "Create and assign a new task to an existing worker",
    inputSchema: z.object({
      workerName: z.string().describe("Worker name to assign to"),
      title: z.string().describe("Task title"),
      description: z.string().describe("Full task description"),
      priority: z.number().optional().describe("Priority 1-4 (1=low, 4=critical)"),
      blockedBy: z.array(z.string()).optional().describe("Task IDs this depends on"),
    }),
    execute: async (params) => {
      const task = store.createTask({
        teamId,
        title: params.title,
        description: params.description,
        assignee: params.workerName,
        priority: params.priority || 2,
        blockedBy: params.blockedBy,
      });
      // Notify worker via mailbox
      store.sendMessage({
        teamId, from: leadName, to: params.workerName,
        msgType: "message",
        content: `New task assigned: "${params.title}" (${task.id}). ${params.description}`,
      });
      return `Task "${params.title}" (${task.id}) assigned to ${params.workerName}.`;
    },
  });

  const reviewPlan = tool({
    description: "Check mailbox for plan submissions from workers",
    inputSchema: z.object({}),
    execute: async () => {
      const msgs = store.readMessages(teamId, leadName);
      const plans = msgs.filter(m => m.msgType === "plan_request");
      if (plans.length === 0) {
        const others = msgs.filter(m => m.msgType !== "plan_request");
        if (others.length > 0) {
          return `No pending plans. Other messages:\n${others.map(m => `[${m.from}] ${m.content}`).join("\n")}`;
        }
        return "No pending plans or messages.";
      }
      return plans.map(p => `Plan from "${p.from}" (request: ${p.requestId}):\n${p.content}`).join("\n\n---\n\n");
    },
  });

  const approvePlan = tool({
    description: "Approve or reject a worker's submitted plan",
    inputSchema: z.object({
      workerName: z.string().describe("Worker who submitted the plan"),
      requestId: z.string().describe("Plan request ID"),
      approved: z.boolean().describe("true to approve, false to reject"),
      feedback: z.string().optional().describe("Feedback for the worker"),
    }),
    execute: async (params) => {
      const msgType = params.approved ? "plan_approved" : "plan_rejected";
      store.sendMessage({
        teamId, from: leadName, to: params.workerName,
        msgType,
        content: params.feedback || (params.approved ? "Plan approved. Proceed." : "Plan rejected. Revise and resubmit."),
        requestId: params.requestId,
      });
      if (params.approved) {
        // Update task status to in_progress
        const tasks = store.listTasks(teamId, { assignee: params.workerName, status: "assigned" });
        for (const t of tasks) {
          store.updateTask(t.id, { status: "in_progress" });
        }
      }
      return `Plan ${params.approved ? "approved" : "rejected"} for ${params.workerName}.${params.feedback ? " Feedback: " + params.feedback : ""}`;
    },
  });

  const checkStatus = tool({
    description: "Check team status — all members, tasks, and pending messages",
    inputSchema: z.object({}),
    execute: async () => {
      const members = store.listMembers(teamId);
      const tasks = store.listTasks(teamId);
      const memberLines = members.map(m => `  ${m.name} [${m.role}/${m.profile || "general"}] — ${m.status}`).join("\n");
      const taskLines = tasks.map(t => {
        const blocked = t.blockedBy?.length ? ` (blocked by: ${t.blockedBy.join(", ")})` : "";
        return `  ${t.id} "${t.title}" — ${t.status} → ${t.assignee || "unassigned"}${blocked}`;
      }).join("\n");
      const unread = store.unreadCount(teamId, leadName);
      return `TEAM STATUS:\n\nMembers:\n${memberLines}\n\nTasks:\n${taskLines}\n\nUnread messages: ${unread}`;
    },
  });

  const sendMsg = tool({
    description: "Send a message to a worker or broadcast to all",
    inputSchema: z.object({
      to: z.string().describe("Worker name or '*' for broadcast"),
      message: z.string().describe("Message content"),
    }),
    execute: async (params) => {
      if (params.to === "*") {
        store.broadcastMessage({ teamId, from: leadName, content: params.message });
        return "Broadcast sent to all workers.";
      }
      store.sendMessage({ teamId, from: leadName, to: params.to, msgType: "message", content: params.message });
      return `Message sent to ${params.to}.`;
    },
  });

  const completeTeam = tool({
    description: "Mark the team as completed and report final results to the main agent",
    inputSchema: z.object({
      summary: z.string().describe("Final summary of what was accomplished"),
    }),
    execute: async (params) => {
      store.updateTeamStatus(teamId, "completed");
      // Notify all workers to wrap up
      store.broadcastMessage({ teamId, from: leadName, msgType: "shutdown_request", content: "Team completed. Wrap up any remaining work." });
      return params.summary;
    },
  });

  const suggestFeature = tool({
    description: "Suggest a feature or scope change to the main agent for user approval. Use when you discover work outside original requirements.",
    inputSchema: z.object({
      title: z.string().describe("Feature title"),
      description: z.string().describe("What and why"),
      impact: z.string().optional().describe("Impact on current work if any"),
    }),
    execute: async (params) => {
      store.sendMessage({
        teamId, from: leadName, to: "main-agent",
        msgType: "feature_suggestion",
        content: `Feature: ${params.title}\n${params.description}${params.impact ? "\nImpact: " + params.impact : ""}`,
      });
      return `Feature "${params.title}" suggested to main agent. Continue with current tasks — don't wait for approval.`;
    },
  });

  return { createWorker, assignTask, reviewPlan, approvePlan, checkStatus, sendMessage: sendMsg, suggestFeature, completeTeam };
}

// ── Worker Tools (each worker gets these) ───────────────────────────────────

function buildWorkerTools(teamId, workerName, taskId) {

  const submitPlan = tool({
    description: "Submit your execution plan to the team lead for approval. REQUIRED before starting work.",
    inputSchema: z.object({
      plan: z.string().describe("Your execution plan — what you'll do, in what order, what tools you'll use"),
    }),
    execute: async (params) => {
      const requestId = `plan-${taskId}`;
      store.updateTask(taskId, { plan: params.plan, status: "plan_submitted" });
      store.sendMessage({
        teamId, from: workerName, to: "lead",
        msgType: "plan_request",
        content: params.plan,
        requestId,
      });
      return `Plan submitted (${requestId}). Wait for approval from team lead before proceeding. Check mailbox.`;
    },
  });

  const readMail = tool({
    description: "Check your mailbox for messages from the team lead",
    inputSchema: z.object({}),
    execute: async () => {
      const msgs = store.readMessages(teamId, workerName);
      if (msgs.length === 0) return "No new messages.";
      return msgs.map(m => `[${m.msgType}] from ${m.from}: ${m.content}`).join("\n\n");
    },
  });

  const completeTask = tool({
    description: "Mark your assigned task as completed with a result summary",
    inputSchema: z.object({
      result: z.string().describe("Summary of what you accomplished"),
    }),
    execute: async (params) => {
      store.updateTask(taskId, { status: "completed", result: params.result, completed_at: new Date().toISOString() });
      // Auto-unblock dependent tasks
      store.resolveDependencies(teamId, taskId);
      // Notify lead
      store.sendMessage({
        teamId, from: workerName, to: "lead",
        msgType: "status_update",
        content: `Task completed: ${params.result}`,
      });
      return "Task marked as completed. Lead has been notified.";
    },
  });

  const sendToLead = tool({
    description: "Send a message to the team lead (questions, blockers, status updates)",
    inputSchema: z.object({
      message: z.string().describe("Message to send"),
    }),
    execute: async (params) => {
      store.sendMessage({ teamId, from: workerName, to: "lead", msgType: "message", content: params.message });
      return "Message sent to team lead.";
    },
  });

  return { submitPlan, readMail, completeTask, sendToLead };
}

// ── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Create a team and spawn the team lead.
 *
 * @param {object} params
 * @param {string} params.name - Team name
 * @param {object} params.leadContract - Contract for the team lead { task, context, constraints }
 * @param {object[]} params.workers - Worker definitions [{ name, profile, task, skills?, blockedBy? }]
 * @returns {Promise<string>} - Team lead's final report
 */
export async function runTeam({ name, leadContract, workers, project = null, projectType = null, projectRepo = null, projectStack = null }) {
  const ctx = tenantContext.getStore();
  const tenantId = ctx?.tenant?.id || null;

  // Create team in SQLite
  const team = store.createTeam({
    name, tenantId, config: { workers },
    project, projectType, projectRepo, projectStack,
    requirements: leadContract.task,
  });

  // Add lead member
  const lead = store.addMember({
    teamId: team.id,
    name: "lead",
    role: "lead",
    profile: "coordinator",
    instructions: leadContract.task,
  });
  store.updateMemberStatus(lead.id, "working");

  console.log(`[TeamLeadRunner] Created team "${name}" (${team.id}) with ${workers.length} planned workers`);

  // Build lead's system prompt
  const workerBrief = workers.map((w, i) =>
    `${i + 1}. ${w.name} (${w.profile}) — ${w.task.slice(0, 100)}`
  ).join("\n");

  const leadPrompt = buildContract({
    task: leadContract.task,
    context: [
      leadContract.context || "",
      `\nYou are the Team Lead for team "${name}" (${team.id}).`,
      `\nPlanned workers:\n${workerBrief}`,
      `\nYour job:`,
      `1. Create each worker using createWorker (they get spawned immediately)`,
      `2. Review their plans as they submit (use reviewPlan + approvePlan)`,
      `3. Monitor progress (use checkStatus)`,
      `4. When all tasks complete, call completeTeam with a summary`,
      `5. If workers are stuck, send them messages with guidance`,
    ].join("\n"),
    constraints: leadContract.constraints || "Ensure all workers complete their tasks. Report any blockers.",
  });

  // Build lead's AI SDK tools
  const leadTools = buildLeadTools(team.id, "lead");

  // Spawn team lead — gets normal system prompt (SOUL.md + memory + skills) + team context via parentContext
  // No systemPromptOverride — lead benefits from full agent capabilities
  const result = await spawnSubAgent(leadPrompt, {
    profile: "coordinator",
    aiToolOverrides: leadTools,
    parentContext: `You are the Team Lead. Delegate work — never do it yourself. Use your management tools: createWorker, assignTask, reviewPlan, approvePlan, checkStatus, sendMessage, suggestFeature, completeTeam.`,
    depth: 1,
  });

  store.updateMemberStatus(lead.id, "done");
  store.updateTeamStatus(team.id, "completed");

  return typeof result === "string" ? result : result?.text || "Team completed.";
}

/**
 * Re-launch an existing team — resume work with existing state.
 * Lead gets current task status + previous session. Workers re-spawned for incomplete tasks.
 */
export async function relaunchTeam(teamId) {
  const team = store.getTeam(teamId);
  if (!team) throw new Error(`Team "${teamId}" not found`);
  if (team.status === "disbanded") throw new Error(`Team "${teamId}" was disbanded`);

  // Resume if paused
  if (team.status === "paused") store.updateTeamStatus(teamId, "active");

  const members = store.listMembers(teamId);
  const tasks = store.listTasks(teamId);

  // Build current state summary for the lead
  const completedTasks = tasks.filter(t => t.status === "completed");
  const pendingTasks = tasks.filter(t => ["pending", "assigned", "blocked", "in_progress"].includes(t.status));
  const failedTasks = tasks.filter(t => t.status === "failed");

  const stateContext = [
    `RE-LAUNCHING project "${team.project || team.name}" (Team: ${teamId}).`,
    `\nCurrent state:`,
    `- Completed tasks: ${completedTasks.length}`,
    completedTasks.length > 0 ? completedTasks.map(t => `  ✅ "${t.title}" → ${(t.result || "done").slice(0, 80)}`).join("\n") : "",
    `- Pending/in-progress tasks: ${pendingTasks.length}`,
    pendingTasks.length > 0 ? pendingTasks.map(t => `  ⏳ "${t.title}" [${t.status}] → ${t.assignee || "unassigned"}`).join("\n") : "",
    failedTasks.length > 0 ? `- Failed tasks: ${failedTasks.length}\n${failedTasks.map(t => `  ❌ "${t.title}"`).join("\n")}` : "",
    `\nResume work: check what's pending, re-create workers for incomplete tasks, continue to completion.`,
    team.requirements ? `\nOriginal requirements: ${team.requirements.slice(0, 500)}` : "",
    team.projectRepo ? `Repo: ${team.projectRepo}` : "",
    team.projectStack ? `Stack: ${team.projectStack}` : "",
  ].filter(Boolean).join("\n");

  const workerBrief = members.filter(m => m.role === "worker").map(m =>
    `- ${m.name} (${m.profile}) [${m.status}]`
  ).join("\n");

  const leadPrompt = buildContract({
    task: `Resume managing project "${team.project || team.name}". Review current state and continue to completion.`,
    context: `${stateContext}\n\nPrevious workers:\n${workerBrief || "None yet"}`,
    constraints: "Re-create workers only for incomplete tasks. Don't redo completed work.",
  });

  const leadTools = buildLeadTools(teamId, "lead");

  console.log(`[TeamLeadRunner] Re-launching team "${team.name}" (${teamId}) — ${completedTasks.length} done, ${pendingTasks.length} pending`);

  const result = await spawnSubAgent(leadPrompt, {
    profile: "coordinator",
    aiToolOverrides: leadTools,
    parentContext: `You are the Team Lead RESUMING a project. Current state is in your task description. Re-create workers for incomplete tasks only. Don't redo completed work. Use your management tools.`,
    depth: 1,
  });

  return typeof result === "string" ? result : result?.text || "Team resumed.";
}
