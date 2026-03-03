import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { config } from "../config/default.js";
import { v4 as uuidv4 } from "uuid";

const WORKSPACES_DIR = join(config.dataDir, "workspaces");

/**
 * Project Tracker - SQLite-equivalent task/project tracking for the agent.
 *
 * The agent uses this to plan multi-step work, track what's done vs pending,
 * and resume from where it left off if interrupted.
 *
 * Actions:
 *   createProject  - create a project with optional initial task list
 *   addTask        - add a task to an existing project
 *   updateTask     - mark a task as in_progress / done / failed / skipped
 *   getProject     - full status of one project (what's done, what's pending)
 *   listProjects   - all projects with summary
 *   deleteProject  - remove a completed/stale project
 *
 * Storage: data/projects/<id>.json  (JSON files, no external deps)
 */

const PROJECTS_DIR = join(config.dataDir, "projects");

function ensureDir() {
  if (!existsSync(PROJECTS_DIR)) mkdirSync(PROJECTS_DIR, { recursive: true });
}

function loadProject(projectId) {
  const path = join(PROJECTS_DIR, `${projectId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function saveProject(project) {
  ensureDir();
  project.updatedAt = new Date().toISOString();
  writeFileSync(join(PROJECTS_DIR, `${project.id}.json`), JSON.stringify(project, null, 2));
}

const STATUS_ICON = {
  pending:     "⬜",
  in_progress: "🔄",
  done:        "✅",
  failed:      "❌",
  skipped:     "⏭️",
};

const VALID_TASK_STATUSES = ["pending", "in_progress", "done", "failed", "skipped"];

// ─────────────────────────────────────────────────────────────────────────────

export function projectTracker(action, paramsJson) {
  ensureDir();

  const params = paramsJson
    ? (typeof paramsJson === "string" ? JSON.parse(paramsJson) : paramsJson)
    : {};

  switch (action) {

    // ── Create project ───────────────────────────────────────────────────────
    case "createProject": {
      const { name, description = "", tasks = [] } = params;
      if (!name) return "Error: name is required";

      const projectId = uuidv4().slice(0, 8);
      const workspace = join(WORKSPACES_DIR, projectId);
      mkdirSync(workspace, { recursive: true });

      const project = {
        id: projectId,
        name,
        description,
        workspace,
        status: "in_progress",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: tasks.map((t, i) => ({
          id: `t${i + 1}`,
          title: typeof t === "string" ? t : t.title,
          description: typeof t === "string" ? "" : (t.description || ""),
          status: "pending",
          notes: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })),
      };

      saveProject(project);

      const taskList = project.tasks.length > 0
        ? project.tasks.map(t => `  ${STATUS_ICON.pending} [${t.id}] ${t.title}`).join("\n")
        : "  (no tasks yet - use addTask to add them)";

      return `Project created: ${project.id}\nName: ${name}${description ? `\nDescription: ${description}` : ""}\nWorkspace: ${workspace}\nTasks (${project.tasks.length}):\n${taskList}`;
    }

    // ── Add task ─────────────────────────────────────────────────────────────
    case "addTask": {
      const { projectId, title, description = "" } = params;
      if (!projectId || !title) return "Error: projectId and title are required";

      const project = loadProject(projectId);
      if (!project) return `Error: Project "${projectId}" not found`;

      const taskNum = project.tasks.length + 1;
      const task = {
        id: `t${taskNum}`,
        title,
        description,
        status: "pending",
        notes: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      project.tasks.push(task);
      saveProject(project);

      return `Task added: ${STATUS_ICON.pending} [${task.id}] ${title}`;
    }

    // ── Update task ──────────────────────────────────────────────────────────
    case "updateTask": {
      const { projectId, taskId, status, notes = "" } = params;
      if (!projectId || !taskId || !status) {
        return "Error: projectId, taskId, and status are required";
      }
      if (!VALID_TASK_STATUSES.includes(status)) {
        return `Error: status must be one of: ${VALID_TASK_STATUSES.join(", ")}`;
      }

      const project = loadProject(projectId);
      if (!project) return `Error: Project "${projectId}" not found`;

      const task = project.tasks.find(t => t.id === taskId);
      if (!task) return `Error: Task "${taskId}" not found in project ${projectId}`;

      const oldStatus = task.status;
      task.status = status;
      if (notes) task.notes = notes;
      task.updatedAt = new Date().toISOString();

      // Auto-close project when all tasks are in a final state
      const allFinal = project.tasks.every(t => ["done", "failed", "skipped"].includes(t.status));
      if (allFinal) {
        const anyFailed = project.tasks.some(t => t.status === "failed");
        project.status = anyFailed ? "partial" : "done";
      }

      saveProject(project);

      const icon = STATUS_ICON[status] || "?";
      const noteStr = notes ? ` | Notes: ${notes}` : "";
      return `Task [${taskId}] "${task.title}": ${oldStatus} → ${status} ${icon}${noteStr}`;
    }

    // ── Get project ──────────────────────────────────────────────────────────
    case "getProject": {
      const { projectId } = params;
      if (!projectId) return "Error: projectId is required";

      const project = loadProject(projectId);
      if (!project) return `Error: Project "${projectId}" not found`;

      const done    = project.tasks.filter(t => t.status === "done").length;
      const total   = project.tasks.length;
      const pct     = total > 0 ? Math.round((done / total) * 100) : 0;
      const pending = project.tasks.filter(t => t.status === "pending").length;
      const active  = project.tasks.filter(t => t.status === "in_progress").length;

      const taskLines = project.tasks.map(t => {
        const icon  = STATUS_ICON[t.status] || "?";
        const notes = t.notes ? ` ← ${t.notes}` : "";
        const desc  = t.description ? `\n       ${t.description}` : "";
        return `  ${icon} [${t.id}] ${t.title}${notes}${desc}`;
      }).join("\n");

      const summary = [
        `Project: ${project.name} [${project.id}]`,
        `Status: ${project.status} | Progress: ${done}/${total} done (${pct}%)`,
        pending > 0 ? `Pending: ${pending} tasks` : "",
        active  > 0 ? `In progress: ${active} tasks` : "",
        project.description ? `Description: ${project.description}` : "",
        "",
        "Tasks:",
        taskLines || "  (no tasks)",
      ].filter(l => l !== null && l !== undefined).join("\n");

      return summary;
    }

    // ── List all projects ────────────────────────────────────────────────────
    case "listProjects": {
      const files = readdirSync(PROJECTS_DIR).filter(f => f.endsWith(".json"));
      if (files.length === 0) return "No projects found. Use createProject to start one.";

      const projects = files
        .map(f => {
          try { return JSON.parse(readFileSync(join(PROJECTS_DIR, f), "utf-8")); }
          catch { return null; }
        })
        .filter(Boolean);

      projects.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

      const { status: filterStatus, limit = 20 } = params;
      const filtered = filterStatus
        ? projects.filter(p => p.status === filterStatus)
        : projects;

      if (filtered.length === 0) return `No projects with status "${filterStatus}".`;

      return filtered.slice(0, limit).map(p => {
        const done  = p.tasks.filter(t => t.status === "done").length;
        const total = p.tasks.length;
        const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
        const date  = p.updatedAt.slice(0, 10);
        const icon  = p.status === "done" ? "✅" : p.status === "partial" ? "⚠️" : "🔄";
        return `${icon} [${p.id}] ${p.name} | ${done}/${total} (${pct}%) | updated ${date}`;
      }).join("\n");
    }

    // ── Delete project ───────────────────────────────────────────────────────
    case "deleteProject": {
      const { projectId } = params;
      if (!projectId) return "Error: projectId is required";

      const path = join(PROJECTS_DIR, `${projectId}.json`);
      if (!existsSync(path)) return `Error: Project "${projectId}" not found`;

      const project = loadProject(projectId);
      unlinkSync(path);
      return `Project "${project?.name || projectId}" deleted.`;
    }

    default:
      return `Unknown action: "${action}". Valid actions: createProject, addTask, updateTask, getProject, listProjects, deleteProject`;
  }
}

export const projectTrackerDescription =
  `projectTracker(action: string, paramsJson?: string) - Track multi-step project progress. Use this to plan work, mark tasks done/failed, and check what's remaining.
  Actions:
    createProject  - {"name":"Todo App","description":"...","tasks":["Create HTML","Create CSS","Create JS"]}
    addTask        - {"projectId":"abc123","title":"Add dark mode","description":"optional detail"}
    updateTask     - {"projectId":"abc123","taskId":"t1","status":"done","notes":"Created index.html with 8 components"}
    getProject     - {"projectId":"abc123"}   → shows all tasks with ✅⬜🔄❌ status
    listProjects   - {} or {"status":"in_progress"} → summary of all projects
    deleteProject  - {"projectId":"abc123"}
  Task statuses: pending | in_progress | done | failed | skipped
  BEST PRACTICE: Always createProject + list all tasks FIRST, then work through them updating status as you go.`;
