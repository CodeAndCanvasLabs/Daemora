import cron from "node-cron";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config/default.js";
import taskQueue from "../core/TaskQueue.js";
import eventBus from "../core/EventBus.js";

/**
 * Scheduler - cron-based task scheduling.
 *
 * Schedules stored in data/schedules.json.
 * Each schedule creates a Task when its cron expression triggers.
 */

class Scheduler {
  constructor() {
    this.schedules = new Map();
    this.cronJobs = new Map();
    this.schedulesPath = join(config.dataDir, "schedules.json");
    this.running = false;
  }

  /**
   * Start the scheduler - load and activate all schedules.
   */
  start() {
    this.loadSchedules();

    for (const [id, schedule] of this.schedules) {
      if (schedule.enabled) {
        this.activateSchedule(id, schedule);
      }
    }

    this.running = true;
    console.log(
      `[Scheduler] Started - ${this.schedules.size} schedule(s) loaded`
    );
  }

  /**
   * Stop the scheduler - cancel all cron jobs.
   */
  stop() {
    for (const [id, job] of this.cronJobs) {
      job.stop();
    }
    this.cronJobs.clear();
    this.running = false;
    console.log(`[Scheduler] Stopped`);
  }

  /**
   * Create a new schedule.
   * @param {object} options
   * @param {string} options.cronExpression - Cron expression (e.g., "0 9 * * *" = daily at 9 AM)
   * @param {string} options.taskInput - The task/message to send when triggered
   * @param {string} [options.channel] - Channel to use (default: "scheduler")
   * @param {string} [options.model] - Model to use
   * @param {string} [options.name] - Human-readable name
   */
  create({ cronExpression, taskInput, channel, model, name }) {
    if (!cron.validate(cronExpression)) {
      throw new Error(`Invalid cron expression: ${cronExpression}`);
    }

    const id = uuidv4();
    const schedule = {
      id,
      name: name || `Schedule ${id.slice(0, 8)}`,
      cronExpression,
      taskInput,
      channel: channel || "scheduler",
      model: model || null,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastRun: null,
      runCount: 0,
    };

    this.schedules.set(id, schedule);
    this.saveSchedules();
    this.activateSchedule(id, schedule);

    eventBus.emitEvent("schedule:created", { id, name: schedule.name });
    console.log(
      `[Scheduler] Created: "${schedule.name}" (${cronExpression})`
    );

    return schedule;
  }

  /**
   * Update an existing schedule (patch - only fields provided are changed).
   * @param {string} id - Schedule ID (full or prefix)
   * @param {object} patch - Fields to update: cronExpression, taskInput, name, enabled
   */
  update(id, patch) {
    // Support short ID prefix matching
    const fullId = id.length < 36
      ? [...this.schedules.keys()].find((k) => k.startsWith(id))
      : id;

    const schedule = this.schedules.get(fullId);
    if (!schedule) throw new Error(`Schedule not found: ${id}`);

    // Update cron expression - requires restarting the cron job
    if (patch.cronExpression && patch.cronExpression !== schedule.cronExpression) {
      if (!cron.validate(patch.cronExpression)) {
        throw new Error(`Invalid cron expression: ${patch.cronExpression}`);
      }
      const job = this.cronJobs.get(fullId);
      if (job) { job.stop(); this.cronJobs.delete(fullId); }
      schedule.cronExpression = patch.cronExpression;
      if (schedule.enabled) this.activateSchedule(fullId, schedule);
    }

    if (patch.taskInput !== undefined) schedule.taskInput = patch.taskInput;
    if (patch.name !== undefined) schedule.name = patch.name;

    // Enable / disable
    if (patch.enabled === false && schedule.enabled !== false) {
      const job = this.cronJobs.get(fullId);
      if (job) { job.stop(); this.cronJobs.delete(fullId); }
      schedule.enabled = false;
    } else if (patch.enabled === true && schedule.enabled !== true) {
      schedule.enabled = true;
      if (!this.cronJobs.has(fullId)) this.activateSchedule(fullId, schedule);
    }

    this.saveSchedules();
    console.log(`[Scheduler] Updated: "${schedule.name}" (${schedule.cronExpression})`);
    return schedule;
  }

  /**
   * Delete a schedule.
   */
  delete(id) {
    const job = this.cronJobs.get(id);
    if (job) {
      job.stop();
      this.cronJobs.delete(id);
    }

    this.schedules.delete(id);
    this.saveSchedules();
    console.log(`[Scheduler] Deleted schedule: ${id}`);
  }

  /**
   * List all schedules.
   */
  list() {
    return [...this.schedules.values()];
  }

  /**
   * Activate a cron job for a schedule.
   */
  activateSchedule(id, schedule) {
    const job = cron.schedule(schedule.cronExpression, () => {
      this.triggerSchedule(id);
    });

    this.cronJobs.set(id, job);
  }

  /**
   * Trigger a scheduled task.
   */
  triggerSchedule(id) {
    const schedule = this.schedules.get(id);
    if (!schedule || !schedule.enabled) return;

    console.log(`[Scheduler] Triggering: "${schedule.name}"`);

    taskQueue.enqueue({
      input: schedule.taskInput,
      channel: schedule.channel,
      model: schedule.model,
      sessionId: null,
      priority: 3, // Scheduled tasks get slightly higher priority
    });

    schedule.lastRun = new Date().toISOString();
    schedule.runCount++;
    this.saveSchedules();

    eventBus.emitEvent("schedule:triggered", {
      id,
      name: schedule.name,
      runCount: schedule.runCount,
    });
  }

  /**
   * Load schedules from disk.
   */
  loadSchedules() {
    if (!existsSync(this.schedulesPath)) return;

    try {
      const data = JSON.parse(readFileSync(this.schedulesPath, "utf-8"));
      for (const schedule of data) {
        this.schedules.set(schedule.id, schedule);
      }
    } catch (error) {
      console.log(`[Scheduler] Error loading schedules: ${error.message}`);
    }
  }

  /**
   * Save schedules to disk.
   */
  saveSchedules() {
    try {
      const data = [...this.schedules.values()];
      writeFileSync(this.schedulesPath, JSON.stringify(data, null, 2), "utf-8");
    } catch (error) {
      console.log(`[Scheduler] Error saving schedules: ${error.message}`);
    }
  }
}

const scheduler = new Scheduler();
export default scheduler;
