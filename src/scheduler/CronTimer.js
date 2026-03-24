/**
 * CronTimer - timer management with croner library.
 *
 * Handles all 3 schedule kinds: cron (expression), every (interval), at (one-shot).
 * Provides timezone support, nextRun computation, stagger, min refire gap.
 */
import { Cron } from "croner";
import { createHash } from "crypto";

const MIN_REFIRE_GAP_MS = 2000; // 2s minimum between fires

/**
 * Create a timer for a job. Returns { stop(), nextRun() }.
 * @param {object} job
 * @param {function} onFire - called when timer fires
 * @returns {{ stop: function, nextRun: function }}
 */
export function createTimer(job, onFire) {
  const { kind, expr, tz, everyMs, at } = job.schedule;
  let cronInstance = null;
  let intervalId = null;
  let timeoutId = null;
  let stopped = false;

  const staggerMs = computeStagger(job.id, job.schedule.staggerMs || 0);
  let lastFireTime = 0;

  const fire = () => {
    if (stopped) return;
    const now = Date.now();
    if (now - lastFireTime < MIN_REFIRE_GAP_MS) return;
    lastFireTime = now;
    // Apply stagger delay
    if (staggerMs > 0) {
      setTimeout(() => { if (!stopped) onFire(); }, staggerMs);
    } else {
      onFire();
    }
  };

  if (kind === "cron") {
    const opts = {};
    if (tz) opts.timezone = tz;
    cronInstance = new Cron(expr, opts, fire);
  } else if (kind === "every") {
    // setInterval for fixed intervals - first fire after everyMs, then repeat
    intervalId = setInterval(fire, everyMs);
  } else if (kind === "at") {
    const target = new Date(at).getTime();
    const delay = Math.max(0, target - Date.now());
    // setTimeout max is ~24.8 days (2^31 - 1 ms). For longer delays, re-check periodically.
    const MAX_TIMEOUT = 2147483647;
    if (delay <= MAX_TIMEOUT) {
      timeoutId = setTimeout(fire, delay);
    } else {
      // Re-check every 12 hours until within range
      const recheckMs = 12 * 60 * 60 * 1000;
      const recheck = () => {
        if (stopped) return;
        const remaining = target - Date.now();
        if (remaining <= 0) { fire(); return; }
        if (remaining <= MAX_TIMEOUT) { timeoutId = setTimeout(fire, remaining); return; }
        timeoutId = setTimeout(recheck, recheckMs);
      };
      timeoutId = setTimeout(recheck, recheckMs);
    }
  }

  return {
    stop() {
      stopped = true;
      if (cronInstance) { cronInstance.stop(); cronInstance = null; }
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
    },
    nextRun() {
      if (kind === "cron" && cronInstance) {
        const next = cronInstance.nextRun();
        return next ? next.toISOString() : null;
      }
      if (kind === "every" && everyMs) {
        return new Date(lastFireTime + everyMs).toISOString();
      }
      if (kind === "at") {
        const target = new Date(at);
        return target > new Date() ? target.toISOString() : null;
      }
      return null;
    },
  };
}

/**
 * Compute next run time without creating a timer.
 */
export function computeNextRun(job) {
  const { kind, expr, tz, everyMs, at } = job.schedule;
  if (kind === "cron" && expr) {
    try {
      const opts = {};
      if (tz) opts.timezone = tz;
      const c = new Cron(expr, opts);
      const next = c.nextRun();
      c.stop();
      return next ? next.toISOString() : null;
    } catch { return null; }
  }
  if (kind === "every" && everyMs) {
    const base = job.lastRunAt ? new Date(job.lastRunAt).getTime() : Date.now();
    return new Date(base + everyMs).toISOString();
  }
  if (kind === "at" && at) {
    const target = new Date(at);
    return target > new Date() ? target.toISOString() : null;
  }
  return null;
}

/**
 * Validate a schedule config. Throws on invalid.
 */
export function validateSchedule(schedule) {
  const { kind, expr, tz, everyMs, at } = schedule;

  if (!["cron", "every", "at"].includes(kind)) {
    throw new Error(`Invalid schedule kind: "${kind}". Must be cron, every, or at.`);
  }

  if (kind === "cron") {
    if (!expr) throw new Error("cron_expr is required for kind=cron");
    // Validate by trying to create a Cron instance
    const opts = {};
    if (tz) opts.timezone = tz;
    try {
      const c = new Cron(expr, opts);
      c.stop();
    } catch (e) {
      throw new Error(`Invalid cron expression "${expr}": ${e.message}`);
    }
  }

  if (kind === "every") {
    if (!everyMs || everyMs < 10000) {
      throw new Error("everyMs must be at least 10000 (10 seconds) for kind=every");
    }
  }

  if (kind === "at") {
    if (!at) throw new Error("at (ISO timestamp) is required for kind=at");
    const d = new Date(at);
    if (isNaN(d.getTime())) throw new Error(`Invalid at timestamp: "${at}"`);
  }
}

/**
 * Deterministic stagger offset from job ID.
 */
export function computeStagger(jobId, staggerMs) {
  if (!staggerMs || staggerMs <= 0) return 0;
  const hash = createHash("sha256").update(jobId).digest();
  const num = hash.readUInt32BE(0);
  return num % staggerMs;
}
