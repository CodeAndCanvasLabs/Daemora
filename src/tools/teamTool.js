/**
 * teamTask — Main agent tool for creating and managing teams.
 *
 * New architecture (ClawTeam pattern):
 * - Main agent creates a team with a Team Lead + worker definitions
 * - Team Lead (sub-agent) manages workers, assigns tasks, reviews plans
 * - Workers get full contracts, submit plans for approval, execute after approval
 * - All state persistent in SQLite (survives restart)
 *
 * The main agent only uses: createTeam, status, listTeams, disbandTeam
 * Team Lead and Workers use their own tools (injected via aiToolOverrides)
 */

import { runTeam } from "../teams/TeamLeadRunner.js";
import * as store from "../teams/TeamStore.js";
import { applyTemplate, TEAM_TEMPLATES } from "../teams/templates.js";
import tenantContext from "../tenants/TenantContext.js";

export async function teamTask(params) {
  const action = params?.action;

  switch (action) {
    // ── Main agent actions ────────────────────────────────────────────────

    case "createTeam": {
      const name = params.name;
      const task = params.task;
      const context = params.context || "";
      const constraints = params.constraints || "";
      const workers = params.workers || [];

      if (!name) return "Error: name is required.";
      if (!task) return "Error: task is required — what should this team accomplish?";
      if (!workers.length) return "Error: workers array is required — define at least one worker { name, profile, task }.";

      // Validate workers
      for (const w of workers) {
        if (!w.name || !w.profile || !w.task) {
          return `Error: each worker needs { name, profile, task }. Invalid: ${JSON.stringify(w)}`;
        }
      }

      // Check team limit
      const tid = tenantContext.getStore()?.tenant?.id || null;
      const existing = store.listTeams(tid);
      if (existing.length >= 5) {
        return `Error: maximum 5 active teams. Disband one first. Active: ${existing.map(t => t.name).join(", ")}`;
      }

      try {
        const result = await runTeam({
          name,
          leadContract: { task, context, constraints },
          workers,
        });
        return result;
      } catch (err) {
        return `Team failed: ${err.message}`;
      }
    }

    case "status": {
      const teamId = params.teamId;
      if (!teamId) return "Error: teamId is required.";
      const team = store.getTeam(teamId);
      if (!team) return `Team "${teamId}" not found.`;
      const members = store.listMembers(teamId);
      const tasks = store.listTasks(teamId);
      const memberLines = members.map(m => `  ${m.name} [${m.role}/${m.profile || "general"}] — ${m.status}`).join("\n");
      const taskLines = tasks.map(t => `  ${t.id} "${t.title}" — ${t.status} → ${t.assignee || "unassigned"}`).join("\n");
      return `Team: ${team.name} (${team.id}) — ${team.status}\n\nMembers:\n${memberLines}\n\nTasks:\n${taskLines}`;
    }

    case "listTeams": {
      const tid = tenantContext.getStore()?.tenant?.id || null;
      const teams = store.listTeams(tid);
      if (teams.length === 0) return "No active teams.";
      return teams.map(t => `${t.id} "${t.name}" — ${t.status} (created: ${t.createdAt})`).join("\n");
    }

    case "disbandTeam": {
      const teamId = params.teamId;
      if (!teamId) return "Error: teamId is required.";
      store.updateTeamStatus(teamId, "disbanded");
      store.broadcastMessage({ teamId, from: "system", msgType: "shutdown_request", content: "Team disbanded." });
      return `Team "${teamId}" disbanded.`;
    }

    case "listTemplates": {
      return TEAM_TEMPLATES.map(t =>
        `${t.id}: ${t.name} — ${t.description} (${t.workers.length} workers: ${t.workers.map(w => w.name).join(", ")})`
      ).join("\n");
    }

    case "createFromTemplate": {
      const templateId = params.templateId;
      const goal = params.task || params.goal;
      if (!templateId) return "Error: templateId is required. Use listTemplates to see options.";
      if (!goal) return "Error: task/goal is required — what should this team accomplish?";

      const teamConfig = applyTemplate(templateId, goal);
      if (!teamConfig) return `Error: template "${templateId}" not found. Use listTemplates to see options.`;

      // Check team limit
      const tid = tenantContext.getStore()?.tenant?.id || null;
      const existing = store.listTeams(tid);
      if (existing.length >= 5) {
        return `Error: maximum 5 active teams. Disband one first.`;
      }

      try {
        const result = await runTeam({
          name: teamConfig.name,
          leadContract: { task: teamConfig.task, context: teamConfig.context + "\n\n" + (params.context || "") },
          workers: teamConfig.workers,
        });
        return result;
      } catch (err) {
        return `Team failed: ${err.message}`;
      }
    }

    default:
      return `Unknown action "${action}". Available: createTeam, createFromTemplate, listTemplates, status, listTeams, disbandTeam`;
  }
}
