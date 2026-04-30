/**
 * project(action, ...) — multi-step project + task planning.
 *
 * The agent uses this to break large goals into ordered tasks, track
 * what's done, and resume cleanly after a restart.
 *
 * Actions:
 *   createProject   — new project, optionally seeded with tasks
 *   listProjects    — all projects with task counts + status
 *   getProject      — one project with its tasks
 *   updateProject   — patch project fields (name, description, status)
 *   deleteProject   — remove project + all tasks
 *   addTask         — add a task to an existing project
 *   updateTask      — change status / notes
 *   deleteTask      — remove a task
 */

import { z } from "zod";

import type { ProjectStore } from "../../projects/ProjectStore.js";
import { NotFoundError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const taskStatus = z.enum(["pending", "in_progress", "done", "failed", "skipped"]);
const projectStatus = z.enum(["in_progress", "completed", "abandoned"]);

const inputSchema = z.object({
  action: z.enum([
    "createProject", "listProjects", "getProject", "updateProject", "deleteProject",
    "addTask", "updateTask", "deleteTask",
  ]),
  projectId: z.string().optional(),
  taskId: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  projectStatus: projectStatus.optional(),
  title: z.string().optional(),
  status: taskStatus.optional(),
  notes: z.string().optional(),
  tasks: z.array(z.union([
    z.string(),
    z.object({ title: z.string(), description: z.string().optional() }),
  ])).optional(),
});

const STATUS_ICON: Record<string, string> = {
  pending: "⬜",
  in_progress: "🔄",
  done: "✅",
  failed: "❌",
  skipped: "⏭️",
};

export function makeProjectTool(store: ProjectStore): ToolDef<typeof inputSchema, unknown> {
  return {
    name: "project",
    description:
      "Plan and track multi-step projects. Actions: createProject, listProjects, getProject, updateProject, deleteProject, addTask, updateTask, deleteTask.",
    category: "agent",
    source: { kind: "core" },
    tags: ["project", "planning", "tasks"],
    inputSchema,
    async execute(input) {
      switch (input.action) {
        case "createProject": {
          if (!input.name) throw new ValidationError("name is required");
          const tasks: { title: string; description?: string }[] = (input.tasks ?? []).map((t) => {
            if (typeof t === "string") return { title: t };
            return t.description === undefined
              ? { title: t.title }
              : { title: t.title, description: t.description };
          });
          const project = store.createProject({
            name: input.name,
            ...(input.description ? { description: input.description } : {}),
            tasks,
          });
          return {
            id: project.id,
            name: project.name,
            taskCount: tasks.length,
            message: `Project '${project.name}' created (${project.id.slice(0, 8)}) with ${tasks.length} task(s)`,
          };
        }

        case "listProjects": {
          return store.allProjects().map((p) => {
            const tasks = store.listProjectTasks(p.id);
            const byStatus = tasks.reduce<Record<string, number>>((acc, t) => {
              acc[t.status] = (acc[t.status] ?? 0) + 1;
              return acc;
            }, {});
            return {
              id: p.id,
              name: p.name,
              status: p.status,
              taskCount: tasks.length,
              byStatus,
              updatedAt: new Date(p.updatedAt).toISOString(),
            };
          });
        }

        case "getProject": {
          if (!input.projectId) throw new ValidationError("projectId is required");
          const project = store.getProject(input.projectId);
          if (!project) throw new NotFoundError(`Project not found: ${input.projectId}`);
          const tasks = store.listProjectTasks(project.id);
          return {
            project: {
              ...project,
              createdAt: new Date(project.createdAt).toISOString(),
              updatedAt: new Date(project.updatedAt).toISOString(),
            },
            tasks: tasks.map((t) => ({
              id: t.id,
              position: t.position,
              title: t.title,
              description: t.description,
              status: t.status,
              icon: STATUS_ICON[t.status],
              notes: t.notes,
              updatedAt: new Date(t.updatedAt).toISOString(),
            })),
          };
        }

        case "updateProject": {
          if (!input.projectId) throw new ValidationError("projectId is required");
          const patch = {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.projectStatus !== undefined ? { status: input.projectStatus } : {}),
          };
          const ok = store.updateProjectRow(input.projectId, patch);
          if (!ok) throw new NotFoundError(`Project not found: ${input.projectId}`);
          return { id: input.projectId, updated: true };
        }

        case "deleteProject": {
          if (!input.projectId) throw new ValidationError("projectId is required");
          const ok = store.deleteProjectRow(input.projectId);
          if (!ok) throw new NotFoundError(`Project not found: ${input.projectId}`);
          return { id: input.projectId, removed: true };
        }

        case "addTask": {
          if (!input.projectId) throw new ValidationError("projectId is required");
          if (!input.title) throw new ValidationError("title is required");
          const project = store.getProject(input.projectId);
          if (!project) throw new NotFoundError(`Project not found: ${input.projectId}`);
          const task = store.addTask(input.projectId, {
            title: input.title,
            ...(input.description ? { description: input.description } : {}),
          });
          return { id: task.id, projectId: task.projectId, title: task.title, position: task.position };
        }

        case "updateTask": {
          if (!input.taskId) throw new ValidationError("taskId is required");
          const patch = {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
          };
          const ok = store.updateTaskRow(input.taskId, patch);
          if (!ok) throw new NotFoundError(`Task not found: ${input.taskId}`);
          return { id: input.taskId, updated: true };
        }

        case "deleteTask": {
          if (!input.taskId) throw new ValidationError("taskId is required");
          const ok = store.deleteTaskRow(input.taskId);
          if (!ok) throw new NotFoundError(`Task not found: ${input.taskId}`);
          return { id: input.taskId, removed: true };
        }
      }
    },
  };
}
