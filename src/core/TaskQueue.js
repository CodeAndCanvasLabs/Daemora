import { createTask, startTask, completeTask, failTask } from "./Task.js";
import { saveTask, loadTask, recoverStaleTasks, loadPendingTasks } from "../storage/TaskStore.js";
import eventBus from "./EventBus.js";

/**
 * In-memory priority task queue with file persistence.
 *
 * Tasks are:
 * 1. Enqueued (from any channel) → status: pending
 * 2. Dequeued by TaskRunner → status: running
 * 3. Completed or Failed → status: completed/failed
 *
 * File persistence: every state change saves to data/tasks/.
 * On crash recovery: stale "running" tasks are reset to "pending".
 */
class TaskQueue {
  constructor() {
    this.queue = []; // sorted by priority (lower number = higher priority)
    this.active = new Map(); // taskId → task (currently running)
    this.waiters = new Map(); // taskId → { resolve, reject } for sync HTTP callers
  }

  /**
   * Initialize queue - recover stale tasks from a previous crash/restart and
   * re-hydrate the in-memory queue so they execute automatically without human
   * re-input. Tasks that were "running" when the process died are reset to
   * "pending" on disk first, then all pending tasks are loaded back into queue.
   */
  init() {
    const recovered = recoverStaleTasks();

    const pending = loadPendingTasks();
    for (const task of pending) {
      this.queue.push(task);
    }

    if (pending.length > 0) {
      console.log(`[TaskQueue] Requeued ${pending.length} pending task(s) from previous session (${recovered} recovered from crash)`);
    } else {
      console.log(`[TaskQueue] Initialized (no pending tasks from previous session)`);
    }
  }

  /**
   * Add a new task to the queue.
   * @returns {object} The created task
   */
  enqueue(taskInput) {
    const task = createTask(taskInput);
    saveTask(task);

    // Insert into queue sorted by priority
    const insertIdx = this.queue.findIndex((t) => t.priority > task.priority);
    if (insertIdx === -1) {
      this.queue.push(task);
    } else {
      this.queue.splice(insertIdx, 0, task);
    }

    eventBus.emitEvent("task:created", {
      taskId: task.id,
      channel: task.channel,
      priority: task.priority,
      sessionId: task.sessionId,
      input: task.input,
    });
    console.log(`[TaskQueue] Enqueued task ${task.id} (priority: ${task.priority}, queue size: ${this.queue.length})`);

    return task;
  }

  /**
   * Get the next task to process.
   * @param {Set<string>} skipSessions - Session IDs currently being processed (skip tasks from these sessions)
   * @returns {object|null} Next task or null if queue is empty or all tasks are session-blocked
   */
  dequeue(skipSessions = null) {
    if (this.queue.length === 0) return null;

    // Find first task not belonging to an already-active session.
    // This prevents two messages from the same user running concurrently,
    // which would cause history corruption (last-write-wins on setMessages).
    let idx = 0;
    if (skipSessions && skipSessions.size > 0) {
      idx = this.queue.findIndex(
        (t) => !t.sessionId || !skipSessions.has(t.sessionId)
      );
      if (idx === -1) return null; // all pending tasks are session-blocked
    }

    const [task] = this.queue.splice(idx, 1);
    startTask(task);
    saveTask(task);
    this.active.set(task.id, task);

    eventBus.emitEvent("task:started", { taskId: task.id });
    return task;
  }

  /**
   * Mark a task as completed.
   */
  complete(taskId, result) {
    const task = this.active.get(taskId);
    if (!task) return;

    completeTask(task, result);
    saveTask(task);
    this.active.delete(taskId);

    eventBus.emitEvent("task:completed", { taskId: task.id, cost: task.cost, result: task.result });

    // Resolve any sync waiters (normal flow - channel is waiting for completion)
    const waiter = this.waiters.get(taskId);
    if (waiter) {
      waiter.resolve(task);
      this.waiters.delete(taskId);
    } else if (task.channel && task.channel !== "http" && task.channel !== "a2a") {
      // No waiter = recovered task (agent restarted while task was in-flight).
      // Emit so ChannelRegistry can route the reply back to the user automatically.
      eventBus.emitEvent("task:reply:needed", { task });
    }

    return task;
  }

  /**
   * Mark a task as failed.
   */
  fail(taskId, error) {
    const task = this.active.get(taskId);
    if (!task) return;

    failTask(task, error);
    saveTask(task);
    this.active.delete(taskId);

    eventBus.emitEvent("task:failed", { taskId: task.id, error });

    // Reject any sync waiters
    const waiter = this.waiters.get(taskId);
    if (waiter) {
      waiter.resolve(task); // resolve not reject - caller handles error state
      this.waiters.delete(taskId);
    }

    return task;
  }

  /**
   * Wait for a task to complete (used by sync HTTP callers).
   * @returns {Promise<object>} The completed task
   */
  waitForCompletion(taskId, timeoutMs = 1800000) {
    return new Promise((resolve, reject) => {
      // Check if already done
      const existing = loadTask(taskId);
      if (existing && (existing.status === "completed" || existing.status === "failed")) {
        resolve(existing);
        return;
      }

      // Timeout guard - prevent hanging forever (default 5 min)
      const timer = setTimeout(() => {
        this.waiters.delete(taskId);
        const timeoutMsg = `Task is still running after ${timeoutMs / 1000}s - you'll receive the result when it completes.`;
        resolve({
          id: taskId,
          status: "pending",
          error: null,
          result: timeoutMsg,
        });
      }, timeoutMs);

      this.waiters.set(taskId, {
        resolve: (task) => { clearTimeout(timer); resolve(task); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });
  }

  /**
   * Get queue stats.
   */
  stats() {
    return {
      pending: this.queue.length,
      active: this.active.size,
      waiters: this.waiters.size,
    };
  }

  /**
   * Peek at the next task without removing it.
   * @returns {object|null}
   */
  peek() {
    return this.queue[0] || null;
  }

  /**
   * Silently absorb a task into the already-running session.
   * Marks it completed with merged=true so channels skip sending a reply.
   */
  merge(taskId) {
    const task = this.active.get(taskId);
    if (!task) return;
    completeTask(task, "");
    task.merged = true;
    saveTask(task);
    this.active.delete(taskId);
    eventBus.emitEvent("task:completed", { taskId: task.id, merged: true });
    const waiter = this.waiters.get(taskId);
    if (waiter) {
      waiter.resolve(task);
      this.waiters.delete(taskId);
    }
    return task;
  }

  /**
   * Check if there are tasks to process.
   */
  hasWork() {
    return this.queue.length > 0;
  }
}

// Singleton
const taskQueue = new TaskQueue();
export default taskQueue;
