/**
 * Scheduler - production-grade cron scheduling with croner.
 *
 * Features:
 *   - 3 schedule kinds: cron (expression), every (interval), at (one-shot)
 *   - Timezone support per-job (IANA via croner)
 *   - SQLite persistence (cron_jobs + cron_runs tables)
 *   - Missed job catchup on restart (staggered, max 5 at once)
 *   - Retry with exponential backoff
 *   - Failure alerts with cooldown
 *   - Channel delivery (announce) and webhook delivery
 *   - Overlap prevention (skip if already running)
 *   - Stuck job detection (configurable timeout, default 2h)
 *   - Run history with auto-pruning (2000 entries per job)
 *   - Deterministic stagger to avoid thundering herd
 *   - Min 2s refire gap
 *   - Multi-tenant isolation
 *   - Cross-OS (macOS, Linux, Windows)
 */
import { v4 as uuidv4 } from "uuid";
import { existsSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import { config } from "../config/default.js";
import eventBus from "../core/EventBus.js";
import * as CronStore from "./CronStore.js";
import { createTimer, computeNextRun, validateSchedule } from "./CronTimer.js";
import { executeJob } from "./CronExecutor.js";
import { loadPresetByName } from "./DeliveryPresetStore.js";

const MAX_MISSED_CATCHUP = 5;
const MISSED_STAGGER_MS = 5000;
const STUCK_CHECK_INTERVAL_MS = 60000;

class Scheduler {
  constructor() {
    /** @type {Map<string, object>} id -> job */
    this.jobs = new Map();
    /** @type {Map<string, {stop: function, nextRun: function}>} id -> timer */
    this.timers = new Map();
    /** @type {Set<string>} ids currently executing */
    this.runningJobs = new Set();
    this.running = false;
    this._stuckCheckInterval = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start() {
    // Load all jobs from SQLite
    const jobs = CronStore.loadAllJobs();
    for (const job of jobs) {
      this.jobs.set(job.id, job);
    }

    // Migrate from legacy schedules.json if present
    this._migrateFromJson();

    // Activate enabled jobs
    for (const [id, job] of this.jobs) {
      if (job.enabled) this._activate(id, job);
    }

    // Detect and execute missed jobs
    await this._catchupMissedJobs();

    // Start stuck job detection
    this._stuckCheckInterval = setInterval(() => this._detectStuckJobs(), STUCK_CHECK_INTERVAL_MS);

    this.running = true;
    const enabled = [...this.jobs.values()].filter(j => j.enabled).length;
    console.log(`[Scheduler] Started - ${this.jobs.size} job(s), ${enabled} enabled`);
  }

  stop() {
    for (const [id, timer] of this.timers) {
      timer.stop();
    }
    this.timers.clear();

    if (this._stuckCheckInterval) {
      clearInterval(this._stuckCheckInterval);
      this._stuckCheckInterval = null;
    }

    this.running = false;
    console.log(`[Scheduler] Stopped`);
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Create a new cron job.
   * @param {object} opts
   * @param {object} opts.schedule - { kind, expr?, tz?, everyMs?, at?, staggerMs? }
   * @param {string} opts.taskInput
   * @param {string} [opts.name]
   * @param {string} [opts.tenantId]
   * @param {string} [opts.model]
   * @param {string} [opts.thinking]
   * @param {number} [opts.timeoutSeconds]
   * @param {object} [opts.delivery] - { mode, channel, to, channelMeta }
   * @param {number} [opts.maxRetries]
   * @param {number} [opts.retryBackoffMs]
   * @param {object} [opts.failureAlert]
   * @param {boolean} [opts.deleteAfterRun]
   * @returns {object} created job
   */
  create(opts) {
    // Support legacy cronExpression field
    const schedule = opts.schedule || {
      kind: "cron",
      expr: opts.cronExpression,
      tz: opts.timezone || null,
    };

    validateSchedule(schedule);

    const id = uuidv4();
    const now = new Date().toISOString();
    const job = {
      id,
      tenantId: opts.tenantId || null,
      name: opts.name || `Job ${id.slice(0, 8)}`,
      description: opts.description || null,
      enabled: true,
      deleteAfterRun: opts.deleteAfterRun || false,
      schedule,
      taskInput: opts.taskInput,
      model: opts.model || null,
      thinking: opts.thinking || null,
      timeoutSeconds: opts.timeoutSeconds ?? 7200,
      delivery: opts.delivery || { mode: "none" },
      maxRetries: opts.maxRetries ?? 0,
      retryBackoffMs: opts.retryBackoffMs ?? 30000,
      failureAlert: opts.failureAlert || null,
      // Legacy compat
      channel: opts.channel || null,
      channelMeta: opts.channelMeta || null,
      // Runtime state
      nextRunAt: null,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      lastDurationMs: null,
      consecutiveErrors: 0,
      runCount: 0,
      runningSince: null,
      lastFailureAlertAt: null,
      createdAt: now,
      updatedAt: now,
    };

    // Resolve delivery preset by name → ID
    if (opts.deliveryPreset) {
      const preset = loadPresetByName(opts.deliveryPreset);
      if (preset) {
        job.delivery = { mode: "preset", presetId: preset.id };
      }
    }

    // Auto-populate delivery from legacy channel/channelMeta
    if (job.delivery.mode === "none" && opts.channelMeta) {
      job.delivery = {
        mode: "announce",
        channel: opts.channel || "cron",
        to: null,
        channelMeta: opts.channelMeta,
      };
    }

    job.nextRunAt = computeNextRun(job);
    CronStore.saveJob(job);
    this.jobs.set(id, job);
    this._activate(id, job);

    eventBus.emitEvent("cron:created", { id, name: job.name, schedule });
    console.log(`[Scheduler] Created: "${job.name}" (${schedule.kind}: ${schedule.expr || schedule.everyMs || schedule.at})`);

    return job;
  }

  /**
   * Update a job (patch).
   * @param {string} id - full or prefix
   * @param {object} patch
   * @param {string} [tenantId] - for isolation check
   */
  update(id, patch, tenantId = null) {
    const fullId = this._resolveId(id);
    const job = this.jobs.get(fullId);
    if (!job) throw new Error(`Job not found: ${id}`);
    if (tenantId && job.tenantId !== tenantId) throw new Error("Access denied");

    // Schedule change - revalidate and restart timer
    if (patch.schedule) {
      validateSchedule(patch.schedule);
      job.schedule = patch.schedule;
      this._deactivate(fullId);
      job.nextRunAt = computeNextRun(job);
      if (job.enabled) this._activate(fullId, job);
    }

    // Legacy cronExpression support
    if (patch.cronExpression && !patch.schedule) {
      const schedule = { kind: "cron", expr: patch.cronExpression, tz: patch.timezone || job.schedule.tz };
      validateSchedule(schedule);
      job.schedule = schedule;
      this._deactivate(fullId);
      job.nextRunAt = computeNextRun(job);
      if (job.enabled) this._activate(fullId, job);
    }

    // Simple field patches
    if (patch.taskInput !== undefined) job.taskInput = patch.taskInput;
    if (patch.name !== undefined) job.name = patch.name;
    if (patch.description !== undefined) job.description = patch.description;
    if (patch.model !== undefined) job.model = patch.model;
    if (patch.thinking !== undefined) job.thinking = patch.thinking;
    if (patch.timeoutSeconds !== undefined) job.timeoutSeconds = patch.timeoutSeconds;
    if (patch.delivery !== undefined) job.delivery = patch.delivery;
    if (patch.maxRetries !== undefined) job.maxRetries = patch.maxRetries;
    if (patch.retryBackoffMs !== undefined) job.retryBackoffMs = patch.retryBackoffMs;
    if (patch.failureAlert !== undefined) job.failureAlert = patch.failureAlert;
    if (patch.deleteAfterRun !== undefined) job.deleteAfterRun = patch.deleteAfterRun;

    // Enable/disable
    if (patch.enabled === false && job.enabled) {
      this._deactivate(fullId);
      job.enabled = false;
    } else if (patch.enabled === true && !job.enabled) {
      job.enabled = true;
      job.nextRunAt = computeNextRun(job);
      this._activate(fullId, job);
    }

    job.updatedAt = new Date().toISOString();
    CronStore.saveJob(job);

    console.log(`[Scheduler] Updated: "${job.name}"`);
    return job;
  }

  /**
   * Delete a job.
   */
  delete(id, tenantId = null) {
    const fullId = this._resolveId(id);
    const job = this.jobs.get(fullId);
    if (!job) throw new Error(`Job not found: ${id}`);
    if (tenantId && job.tenantId !== tenantId) throw new Error("Access denied");

    this._deactivate(fullId);
    this.jobs.delete(fullId);
    CronStore.deleteJob(fullId);

    eventBus.emitEvent("cron:deleted", { id: fullId, name: job?.name });
    console.log(`[Scheduler] Deleted: "${job?.name || id}"`);
  }

  /**
   * List jobs, optionally filtered by tenant.
   */
  list(tenantId = null) {
    const all = [...this.jobs.values()];
    if (tenantId) return all.filter(j => j.tenantId === tenantId);
    return all;
  }

  /**
   * Force-run a job immediately.
   */
  async forceRun(id, tenantId = null) {
    const fullId = this._resolveId(id);
    const job = this.jobs.get(fullId);
    if (!job) throw new Error(`Job not found: ${id}`);
    if (tenantId && job.tenantId !== tenantId) throw new Error("Access denied");

    if (this.runningJobs.has(fullId)) {
      return `Job "${job.name}" is already running - skipped.`;
    }

    this.runningJobs.add(fullId);
    try {
      await executeJob(job, {
        onComplete: (updatedJob) => {
          this.jobs.set(fullId, updatedJob);
          this._updateNextRun(fullId, updatedJob);
        },
      });
    } finally {
      this.runningJobs.delete(fullId);
    }

    return `Job "${job.name}" triggered.`;
  }

  /**
   * Get run history for a job.
   */
  getHistory(jobId, opts = {}) {
    const fullId = this._resolveId(jobId);
    return CronStore.loadRuns(fullId, opts);
  }

  /**
   * Get global run history.
   */
  getAllHistory(opts = {}) {
    return CronStore.loadAllRuns(opts);
  }

  /**
   * Scheduler status.
   */
  status() {
    const all = [...this.jobs.values()];
    const enabled = all.filter(j => j.enabled);
    const running = [...this.runningJobs];

    // Find next fire time
    let nextWakeAt = null;
    for (const j of enabled) {
      if (j.nextRunAt && (!nextWakeAt || j.nextRunAt < nextWakeAt)) {
        nextWakeAt = j.nextRunAt;
      }
    }

    return {
      running: this.running,
      totalJobs: all.length,
      enabledJobs: enabled.length,
      runningNow: running.length,
      nextWakeAt,
    };
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _activate(id, job) {
    if (this.timers.has(id)) this._deactivate(id);

    const timer = createTimer(job, () => this._onTick(id));
    this.timers.set(id, timer);

    // Update nextRunAt from timer
    const next = timer.nextRun();
    if (next) {
      job.nextRunAt = next;
      CronStore.saveJob(job);
    }
  }

  _deactivate(id) {
    const timer = this.timers.get(id);
    if (timer) {
      timer.stop();
      this.timers.delete(id);
    }
  }

  async _onTick(id) {
    const job = this.jobs.get(id);
    if (!job || !job.enabled) return;

    // Overlap prevention
    if (this.runningJobs.has(id)) {
      console.log(`[Scheduler] Skipping "${job.name}" - still running from previous trigger`);
      return;
    }

    this.runningJobs.add(id);
    try {
      await executeJob(job, {
        onComplete: (updatedJob) => {
          this.jobs.set(id, updatedJob);
          this._updateNextRun(id, updatedJob);
        },
      });
    } catch (e) {
      console.log(`[Scheduler] Execution error for "${job.name}": ${e.message}`);
    } finally {
      this.runningJobs.delete(id);
    }
  }

  _updateNextRun(id, job) {
    const timer = this.timers.get(id);
    if (timer) {
      const next = timer.nextRun();
      if (next) {
        job.nextRunAt = next;
        CronStore.saveJob(job);
      }
    }

    // Auto-disable one-shot "at" jobs after run
    if (job.schedule.kind === "at" && !job.enabled) {
      this._deactivate(id);
    }
  }

  _detectStuckJobs() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (!job.runningSince) continue;

      const elapsed = now - new Date(job.runningSince).getTime();
      const timeoutMs = (job.timeoutSeconds || 7200) * 1000;

      if (elapsed >= timeoutMs) {
        console.log(`[Scheduler] Stuck job detected: "${job.name}" (running ${Math.round(elapsed / 1000)}s, timeout ${job.timeoutSeconds}s)`);

        job.runningSince = null;
        job.lastStatus = "timeout";
        job.lastError = `Job timed out after ${job.timeoutSeconds}s`;
        job.consecutiveErrors = (job.consecutiveErrors || 0) + 1;
        job.updatedAt = new Date().toISOString();
        CronStore.saveJob(job);

        CronStore.saveRun({
          jobId: job.id, tenantId: job.tenantId,
          startedAt: job.runningSince || new Date().toISOString(),
          completedAt: new Date().toISOString(),
          status: "timeout",
          error: job.lastError,
        });

        this.runningJobs.delete(id);

        eventBus.emitEvent("cron:timeout", { jobId: job.id, name: job.name });
      }
    }
  }

  async _catchupMissedJobs() {
    const now = new Date();
    const missed = [];

    for (const [id, job] of this.jobs) {
      if (!job.enabled) continue;
      // One-shots: catch up only if never ran (runCount === 0)
      if (job.schedule.kind === "at" && job.runCount > 0) continue;
      if (!job.nextRunAt) continue;

      const nextRun = new Date(job.nextRunAt);
      if (nextRun < now) {
        // This job should have fired but didn't (server was down)
        const lastRun = job.lastRunAt ? new Date(job.lastRunAt) : new Date(0);
        if (lastRun < nextRun) {
          missed.push(job);
        }
      }
    }

    if (missed.length === 0) return;

    // Sort by nextRunAt (oldest first)
    missed.sort((a, b) => new Date(a.nextRunAt) - new Date(b.nextRunAt));

    console.log(`[Scheduler] ${missed.length} missed job(s) detected - catching up (max ${MAX_MISSED_CATCHUP} at once)`);

    // Execute in batches
    const batch = missed.slice(0, MAX_MISSED_CATCHUP);
    for (let i = 0; i < batch.length; i++) {
      if (i > 0) await _sleep(MISSED_STAGGER_MS);
      const job = batch[i];
      console.log(`[Scheduler] Catchup: "${job.name}" (was due ${job.nextRunAt})`);
      this.runningJobs.add(job.id);
      executeJob(job, {
        onComplete: (updatedJob) => {
          this.jobs.set(job.id, updatedJob);
          this._updateNextRun(job.id, updatedJob);
          this.runningJobs.delete(job.id);
        },
      }).catch(() => this.runningJobs.delete(job.id));
    }
  }

  _resolveId(id) {
    if (this.jobs.has(id)) return id;
    // Prefix match
    const match = [...this.jobs.keys()].find(k => k.startsWith(id));
    return match || id;
  }

  // ── Legacy migration from schedules.json ──────────────────────────────────

  _migrateFromJson() {
    const jsonPath = join(config.dataDir, "schedules.json");
    if (!existsSync(jsonPath)) return;

    try {
      const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
      if (!Array.isArray(data) || data.length === 0) return;

      let migrated = 0;
      for (const s of data) {
        if (this.jobs.has(s.id)) continue; // Already migrated

        const job = {
          id: s.id,
          tenantId: null,
          name: s.name || `Schedule ${s.id.slice(0, 8)}`,
          description: null,
          enabled: s.enabled !== false,
          deleteAfterRun: false,
          schedule: { kind: "cron", expr: s.cronExpression, tz: null },
          taskInput: s.taskInput,
          model: s.model || null,
          thinking: null,
          timeoutSeconds: 7200,
          delivery: s.channelMeta
            ? { mode: "announce", channel: s.channel || "cron", to: null, channelMeta: s.channelMeta }
            : { mode: "none" },
          maxRetries: 0,
          retryBackoffMs: 30000,
          failureAlert: null,
          nextRunAt: null,
          lastRunAt: s.lastRun || null,
          lastStatus: null,
          lastError: null,
          lastDurationMs: null,
          consecutiveErrors: 0,
          runCount: s.runCount || 0,
          runningSince: null,
          lastFailureAlertAt: null,
          createdAt: s.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        job.nextRunAt = computeNextRun(job);
        CronStore.saveJob(job);
        this.jobs.set(job.id, job);
        migrated++;
      }

      // Rename old file
      renameSync(jsonPath, jsonPath + ".bak");
      console.log(`[Scheduler] Migrated ${migrated} job(s) from schedules.json → SQLite`);
    } catch (e) {
      console.log(`[Scheduler] Migration error: ${e.message}`);
    }
  }
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const scheduler = new Scheduler();
export default scheduler;
