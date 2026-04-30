/**
 * ProjectStore — multi-step project / task planning persistence.
 *
 * Unlike TaskStore (agent turn records) or TeamStore (multi-worker
 * orchestration), ProjectStore is the agent's own "write plan, check
 * off tasks" notebook. It survives restarts so the agent can resume
 * long-running work after a crash or new session.
 *
 * Tables:
 *   projects        — top-level project with id, name, status
 *   project_tasks   — ordered tasks per project with per-task status
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import { createLogger } from "../util/logger.js";

const log = createLogger("projects");

const TASK_STATUSES = ["pending", "in_progress", "done", "failed", "skipped"] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

const PROJECT_STATUSES = ["in_progress", "completed", "abandoned"] as const;
export type ProjectStatus = typeof PROJECT_STATUSES[number];

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: ProjectStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProjectTaskRow {
  readonly id: string;
  readonly projectId: string;
  readonly position: number;
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly notes: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'in_progress',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_tasks (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending',
  notes       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS project_tasks_by_project ON project_tasks(project_id, position);
`;

export class ProjectStore {
  private readonly insertProject: Database.Statement;
  private readonly updateProject: Database.Statement;
  private readonly selectProject: Database.Statement;
  private readonly listProjects: Database.Statement;
  private readonly deleteProject: Database.Statement;
  private readonly insertTask: Database.Statement;
  private readonly updateTask: Database.Statement;
  private readonly selectTask: Database.Statement;
  private readonly listTasks: Database.Statement;
  private readonly deleteTask: Database.Statement;
  private readonly nextPosition: Database.Statement;

  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA);

    this.insertProject = db.prepare(
      `INSERT INTO projects (id, name, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.updateProject = db.prepare(
      `UPDATE projects SET name=?, description=?, status=?, updated_at=? WHERE id=?`,
    );
    this.selectProject = db.prepare(
      `SELECT id, name, description, status, created_at AS createdAt, updated_at AS updatedAt
       FROM projects WHERE id=?`,
    );
    this.listProjects = db.prepare(
      `SELECT id, name, description, status, created_at AS createdAt, updated_at AS updatedAt
       FROM projects ORDER BY updated_at DESC`,
    );
    this.deleteProject = db.prepare(`DELETE FROM projects WHERE id=?`);

    this.insertTask = db.prepare(
      `INSERT INTO project_tasks (id, project_id, position, title, description, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.updateTask = db.prepare(
      `UPDATE project_tasks SET title=?, description=?, status=?, notes=?, updated_at=? WHERE id=?`,
    );
    this.selectTask = db.prepare(
      `SELECT id, project_id AS projectId, position, title, description, status, notes,
              created_at AS createdAt, updated_at AS updatedAt
       FROM project_tasks WHERE id=?`,
    );
    this.listTasks = db.prepare(
      `SELECT id, project_id AS projectId, position, title, description, status, notes,
              created_at AS createdAt, updated_at AS updatedAt
       FROM project_tasks WHERE project_id=? ORDER BY position ASC`,
    );
    this.deleteTask = db.prepare(`DELETE FROM project_tasks WHERE id=?`);
    this.nextPosition = db.prepare(
      `SELECT COALESCE(MAX(position), 0) + 1 AS next FROM project_tasks WHERE project_id=?`,
    );
  }

  createProject(opts: { name: string; description?: string; tasks?: readonly { title: string; description?: string }[] }): ProjectRow {
    const id = randomUUID();
    const now = Date.now();
    this.insertProject.run(id, opts.name, opts.description ?? "", "in_progress", now, now);
    if (opts.tasks?.length) {
      for (let i = 0; i < opts.tasks.length; i++) {
        const t = opts.tasks[i]!;
        this.addTask(id, { title: t.title, ...(t.description ? { description: t.description } : {}) });
      }
    }
    log.info({ id, name: opts.name, tasks: opts.tasks?.length ?? 0 }, "project created");
    return this.getProject(id)!;
  }

  getProject(id: string): ProjectRow | null {
    return (this.selectProject.get(id) as ProjectRow) ?? null;
  }

  allProjects(): readonly ProjectRow[] {
    return this.listProjects.all() as ProjectRow[];
  }

  updateProjectRow(id: string, patch: Partial<Pick<ProjectRow, "name" | "description" | "status">>): boolean {
    const existing = this.getProject(id);
    if (!existing) return false;
    this.updateProject.run(
      patch.name ?? existing.name,
      patch.description ?? existing.description,
      patch.status ?? existing.status,
      Date.now(),
      id,
    );
    return true;
  }

  deleteProjectRow(id: string): boolean {
    return this.deleteProject.run(id).changes > 0;
  }

  addTask(projectId: string, opts: { title: string; description?: string }): ProjectTaskRow {
    const id = randomUUID();
    const now = Date.now();
    const pos = (this.nextPosition.get(projectId) as { next: number }).next;
    this.insertTask.run(id, projectId, pos, opts.title, opts.description ?? "", "pending", "", now, now);
    return this.getTask(id)!;
  }

  getTask(id: string): ProjectTaskRow | null {
    return (this.selectTask.get(id) as ProjectTaskRow) ?? null;
  }

  listProjectTasks(projectId: string): readonly ProjectTaskRow[] {
    return this.listTasks.all(projectId) as ProjectTaskRow[];
  }

  updateTaskRow(id: string, patch: Partial<Pick<ProjectTaskRow, "title" | "description" | "status" | "notes">>): boolean {
    const existing = this.getTask(id);
    if (!existing) return false;
    this.updateTask.run(
      patch.title ?? existing.title,
      patch.description ?? existing.description,
      patch.status ?? existing.status,
      patch.notes ?? existing.notes,
      Date.now(),
      id,
    );
    return true;
  }

  deleteTaskRow(id: string): boolean {
    return this.deleteTask.run(id).changes > 0;
  }
}

export { TASK_STATUSES, PROJECT_STATUSES };
