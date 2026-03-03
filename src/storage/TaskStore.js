import { writeFileSync, readFileSync, existsSync, readdirSync } from "fs";
import { config } from "../config/default.js";

const TASKS_DIR = config.tasksDir;

/**
 * Save a task to disk.
 */
export function saveTask(task) {
  const filePath = `${TASKS_DIR}/${task.id}.json`;
  writeFileSync(filePath, JSON.stringify(task, null, 2));
}

/**
 * Load a task by ID.
 */
export function loadTask(taskId) {
  const filePath = `${TASKS_DIR}/${taskId}.json`;
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

/**
 * List recent tasks (sorted by createdAt descending).
 */
export function listTasks({ limit = 20, status = null } = {}) {
  const files = readdirSync(TASKS_DIR).filter((f) => f.endsWith(".json"));
  let tasks = files.map((f) => {
    try {
      return JSON.parse(readFileSync(`${TASKS_DIR}/${f}`, "utf-8"));
    } catch {
      return null;
    }
  }).filter(Boolean);

  if (status) {
    tasks = tasks.filter((t) => t.status === status);
  }

  tasks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return tasks.slice(0, limit);
}

/**
 * On startup, find tasks stuck in "running" state and reset to "pending".
 * Returns the count of tasks reset so the caller can log accordingly.
 */
export function recoverStaleTasks() {
  let recovered = 0;
  try {
    const files = readdirSync(TASKS_DIR).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try {
        const task = JSON.parse(readFileSync(`${TASKS_DIR}/${f}`, "utf-8"));
        if (task.status === "running") {
          task.status = "pending";
          task.startedAt = null;
          writeFileSync(`${TASKS_DIR}/${f}`, JSON.stringify(task, null, 2));
          recovered++;
          console.log(`[TaskStore] Recovered stale task: ${task.id}`);
        }
      } catch {
        // skip corrupt files
      }
    }
  } catch {
    // TASKS_DIR may not exist yet on first run
  }
  return recovered;
}

/**
 * Load all tasks currently in "pending" state from disk, sorted oldest-first.
 * Used by TaskQueue.init() to re-hydrate the in-memory queue after a restart.
 */
export function loadPendingTasks() {
  try {
    const files = readdirSync(TASKS_DIR).filter((f) => f.endsWith(".json"));
    return files
      .map((f) => {
        try { return JSON.parse(readFileSync(`${TASKS_DIR}/${f}`, "utf-8")); }
        catch { return null; }
      })
      .filter((t) => t && t.status === "pending")
      .sort((a, b) => {
        // Sort by priority first (lower number = higher priority), then by createdAt (oldest first)
        if (a.priority !== b.priority) return (a.priority || 5) - (b.priority || 5);
        return new Date(a.createdAt) - new Date(b.createdAt);
      });
  } catch {
    return [];
  }
}
