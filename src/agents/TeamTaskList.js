/**
 * TeamTaskList — shared task list with claim/lock mechanics and dependency tracking.
 *
 * Each TeamTaskList instance is scoped to a single team.
 * Node.js single-threaded = no race conditions on claims.
 *
 * Task lifecycle: pending → claimed → in_progress → completed (or failed → back to pending)
 */

import { v4 as uuidv4 } from "uuid";

export default class TeamTaskList {
  constructor() {
    /** @type {Map<string, object>} */
    this._tasks = new Map();
  }

  /**
   * Add a task to the shared list.
   * @param {object} opts
   * @param {string} opts.title
   * @param {string} [opts.description]
   * @param {string[]} [opts.blockedBy] - Task IDs that must complete before this one is claimable
   * @returns {{id: string, title: string, status: string}}
   */
  add({ title, description = "", blockedBy = [] }) {
    if (!title) throw new Error("Task title is required");
    const id = uuidv4().slice(0, 8);
    const task = {
      id,
      title,
      description,
      status: "pending",
      assignee: null,
      blockedBy: [...blockedBy],
      result: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this._tasks.set(id, task);
    return { id: task.id, title: task.title, status: task.status };
  }

  /**
   * Claim a pending task. Checks deps are completed and task is pending.
   * @param {string} taskId
   * @param {string} teammateId
   * @returns {object} Updated task
   */
  claim(taskId, teammateId) {
    const task = this._tasks.get(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);
    if (task.status !== "pending") {
      throw new Error(`Task "${taskId}" is ${task.status}, not pending — cannot claim`);
    }
    // Check all deps are completed
    for (const depId of task.blockedBy) {
      const dep = this._tasks.get(depId);
      if (!dep || dep.status !== "completed") {
        throw new Error(`Task "${taskId}" blocked by "${depId}" (${dep?.status || "missing"})`);
      }
    }
    task.status = "claimed";
    task.assignee = teammateId;
    task.updatedAt = Date.now();
    return this._serialize(task);
  }

  /**
   * Mark a claimed/in_progress task as completed.
   * @param {string} taskId
   * @param {string} teammateId
   * @param {string} [result]
   * @returns {object} Updated task
   */
  complete(taskId, teammateId, result = "") {
    const task = this._tasks.get(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);
    if (task.assignee !== teammateId) {
      throw new Error(`Task "${taskId}" is assigned to "${task.assignee}", not "${teammateId}"`);
    }
    task.status = "completed";
    task.result = result;
    task.updatedAt = Date.now();
    return this._serialize(task);
  }

  /**
   * Mark a task as failed — releases it back to pending for retry.
   * @param {string} taskId
   * @param {string} teammateId
   * @param {string} [reason]
   * @returns {object} Updated task
   */
  fail(taskId, teammateId, reason = "") {
    const task = this._tasks.get(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);
    if (task.assignee !== teammateId) {
      throw new Error(`Task "${taskId}" is assigned to "${task.assignee}", not "${teammateId}"`);
    }
    task.status = "pending";
    task.assignee = null;
    task.result = reason ? `FAILED: ${reason}` : null;
    task.updatedAt = Date.now();
    return this._serialize(task);
  }

  /**
   * Query tasks with optional filters.
   * @param {object} [opts]
   * @param {string} [opts.status]
   * @param {string} [opts.assignee]
   * @returns {Array}
   */
  list({ status, assignee } = {}) {
    let tasks = [...this._tasks.values()];
    if (status) tasks = tasks.filter((t) => t.status === status);
    if (assignee) tasks = tasks.filter((t) => t.assignee === assignee);
    return tasks.map((t) => this._serialize(t));
  }

  /**
   * Get tasks that are pending AND have all dependencies completed.
   * @returns {Array}
   */
  claimable() {
    return [...this._tasks.values()]
      .filter((t) => {
        if (t.status !== "pending") return false;
        return t.blockedBy.every((depId) => {
          const dep = this._tasks.get(depId);
          return dep && dep.status === "completed";
        });
      })
      .map((t) => this._serialize(t));
  }

  /** Check if all tasks are completed. */
  allDone() {
    if (this._tasks.size === 0) return true;
    return [...this._tasks.values()].every((t) => t.status === "completed");
  }

  /** Quick summary: total, pending, claimed, in_progress, completed, failed. */
  summary() {
    const counts = { total: 0, pending: 0, claimed: 0, in_progress: 0, completed: 0 };
    for (const t of this._tasks.values()) {
      counts.total++;
      counts[t.status] = (counts[t.status] || 0) + 1;
    }
    counts.allDone = this.allDone();
    return counts;
  }

  /** Get a single task by ID. */
  get(taskId) {
    const task = this._tasks.get(taskId);
    return task ? this._serialize(task) : null;
  }

  _serialize(task) {
    return { ...task };
  }
}
