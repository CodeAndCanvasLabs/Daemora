/**
 * TeamTaskList — shared task list with claim/lock mechanics, dependency tracking, and priority.
 *
 * Each TeamTaskList instance is scoped to a single team.
 * Node.js single-threaded = no race conditions on claims.
 *
 * Task lifecycle: pending → claimed → in_progress → completed (or failed → back to pending)
 * Priority: critical(4) > high(3) > medium(2) > low(1)
 * Topological sort: Kahn's algorithm + priority tie-breaking for execution order.
 */

import { v4 as uuidv4 } from "uuid";

const PRIORITY_VALUES = { critical: 4, high: 3, medium: 2, low: 1 };

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
   * @param {string} [opts.priority] - critical|high|medium|low (default: medium)
   * @param {Function} [opts.onRollback] - Rollback callback if workflow fails
   * @returns {{id: string, title: string, status: string, priority: string}}
   */
  add({ title, description = "", blockedBy = [], priority = "medium", onRollback = null }) {
    if (!title) throw new Error("Task title is required");
    const id = uuidv4().slice(0, 8);
    const task = {
      id,
      title,
      description,
      status: "pending",
      assignee: null,
      blockedBy: [...blockedBy],
      priority: PRIORITY_VALUES[priority] ? priority : "medium",
      result: null,
      onRollback,
      startedAt: null,
      completedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this._tasks.set(id, task);
    return { id: task.id, title: task.title, status: task.status, priority: task.priority };
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
    task.startedAt = Date.now();
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
    task.completedAt = Date.now();
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
   * Sorted by priority (critical first).
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
      .sort((a, b) => (PRIORITY_VALUES[b.priority] || 2) - (PRIORITY_VALUES[a.priority] || 2))
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

  /**
   * Unclaim a claimed task — release it back to pending.
   * Used when a teammate is restarted and its claimed tasks need recycling.
   * @param {string} taskId
   * @returns {object} Updated task
   */
  unclaim(taskId) {
    const task = this._tasks.get(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);
    if (task.status !== "claimed") {
      throw new Error(`Task "${taskId}" is ${task.status}, not claimed — cannot unclaim`);
    }
    task.status = "pending";
    task.assignee = null;
    task.updatedAt = Date.now();
    return this._serialize(task);
  }

  /** Get a single task by ID. */
  get(taskId) {
    const task = this._tasks.get(taskId);
    return task ? this._serialize(task) : null;
  }

  /**
   * Topological sort — resolves execution order respecting deps + priority.
   * Kahn's algorithm with priority tie-breaking.
   * @returns {Array} Tasks in execution order
   * @throws if circular dependency detected
   */
  resolveExecutionOrder() {
    const resolved = [];
    const resolvedIds = new Set();
    const remaining = [...this._tasks.values()];

    while (remaining.length > 0) {
      const ready = remaining.filter(t =>
        t.blockedBy.every(depId => resolvedIds.has(depId))
      );

      if (ready.length === 0 && remaining.length > 0) {
        const stuck = remaining.map(t => t.id).join(", ");
        throw new Error(`Circular dependency detected among tasks: ${stuck}`);
      }

      // Sort ready tasks by priority (critical first)
      ready.sort((a, b) => (PRIORITY_VALUES[b.priority] || 2) - (PRIORITY_VALUES[a.priority] || 2));

      for (const task of ready) {
        resolved.push(this._serialize(task));
        resolvedIds.add(task.id);
        remaining.splice(remaining.indexOf(task), 1);
      }
    }

    return resolved;
  }

  /**
   * Rollback completed tasks in reverse order.
   * Calls onRollback() on each completed task that has one.
   * @returns {{rolledBack: number, errors: string[]}}
   */
  async rollback() {
    const completed = [...this._tasks.values()]
      .filter(t => t.status === "completed")
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0)); // reverse chronological

    let rolledBack = 0;
    const errors = [];

    for (const task of completed) {
      if (typeof task.onRollback === "function") {
        try {
          await task.onRollback();
          task.status = "pending";
          task.assignee = null;
          task.result = null;
          task.completedAt = null;
          task.updatedAt = Date.now();
          rolledBack++;
        } catch (e) {
          errors.push(`${task.id}: ${e.message}`);
          // Continue rollback — don't stop on individual errors
        }
      }
    }

    return { rolledBack, errors };
  }

  /**
   * Get task duration in ms (completedAt - startedAt).
   * @param {string} taskId
   * @returns {number|null}
   */
  getDuration(taskId) {
    const task = this._tasks.get(taskId);
    if (!task || !task.startedAt) return null;
    const end = task.completedAt || Date.now();
    return end - task.startedAt;
  }

  _serialize(task) {
    const { onRollback, ...rest } = task;
    return { ...rest, hasRollback: typeof onRollback === "function" };
  }
}
