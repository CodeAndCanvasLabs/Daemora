/**
 * CronExecutor - executes cron jobs with retry, delivery, alerts.
 *
 * Each job runs through TaskQueue in an isolated session.
 * Handles: overlap prevention, retry with backoff, channel/webhook delivery,
 * failure alerts with cooldown, stuck job detection, run logging.
 */
import { v4 as uuidv4 } from "uuid";
import taskQueue from "../core/TaskQueue.js";
import eventBus from "../core/EventBus.js";
import channelRegistry from "../channels/index.js";
import { saveRun, pruneRuns, saveJob } from "./CronStore.js";

/**
 * Execute a cron job.
 * @param {object} job
 * @param {object} [opts]
 * @param {boolean} [opts.isRetry]
 * @param {number} [opts.retryAttempt]
 * @param {function} [opts.onComplete] - called with updated job after execution
 */
export async function executeJob(job, { isRetry = false, retryAttempt = 0, onComplete } = {}) {
  // ── Overlap check ─────────────────────────────────────────────────────────
  if (job.runningSince) {
    const stuckMs = Date.now() - new Date(job.runningSince).getTime();
    const timeoutMs = (job.timeoutSeconds || 7200) * 1000;

    if (stuckMs < timeoutMs) {
      console.log(`[CronExecutor] Skipping "${job.name}" - already running since ${job.runningSince}`);
      saveRun({
        jobId: job.id, startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(), status: "skipped",
        error: "Skipped: previous run still active", retryAttempt,
      });
      return;
    }
    // Stuck - force-clear and proceed
    console.log(`[CronExecutor] Clearing stuck job "${job.name}" (running ${Math.round(stuckMs / 1000)}s)`);
    _recordFailure(job, "Job timed out - cleared stuck state", retryAttempt);
  }

  // ── Mark as running ───────────────────────────────────────────────────────
  const runId = uuidv4();
  const startedAt = new Date().toISOString();
  job.runningSince = startedAt;
  saveJob(job);

  // Use the main session so cron runs are part of continuous chat history,
  // not isolated per-job sessions.
  const sessionId = "main";
  let taskId = null;

  console.log(`[CronExecutor] Running "${job.name}"${isRetry ? ` (retry #${retryAttempt})` : ""}`);

  try {
    // ── Build cron input with context ──────────────────────────────────────
    const cronLines = [
      "[Scheduled Task] You are running autonomously as a cron job. No user present.",
      "Execute the task fully. If one approach fails, try another. Only return when genuinely blocked.",
      "Need previous run details? Use cron('history', {id: '" + job.id.slice(0, 8) + "'}) to check past executions.",
      "Your response will be delivered to the configured channels automatically.",
    ];

    // Inject last execution result if exists
    if (job.lastRunAt && job.lastStatus) {
      const lastPreview = job.lastError || "";
      cronLines.push(`[Previous run: ${job.lastRunAt} - ${job.lastStatus}${lastPreview ? `: ${lastPreview.slice(0, 150)}` : ""}]`);
    }

    cronLines.push("", "[Task]:", job.taskInput);
    const cronInput = cronLines.join("\n");

    // ── Enqueue task ──────────────────────────────────────────────────────
    const enqueuedTask = taskQueue.enqueue({
      input: cronInput,
      channel: job.delivery?.channel || "cron",
      channelMeta: job.delivery?.channelMeta || null,
      model: job.model || null,
      sessionId,
      priority: 3,
      type: "cron",
    });
    taskId = enqueuedTask.id;

    // ── Wait for completion ───────────────────────────────────────────────
    const timeoutMs = (job.timeoutSeconds || 7200) * 1000;
    const result = await taskQueue.waitForCompletion(taskId, timeoutMs);
    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

    // ── Success ───────────────────────────────────────────────────────────
    const resultText = typeof result === "string" ? result : (result?.text || result?.result || "Task completed.");
    const preview = resultText.slice(0, 500);

    job.runningSince = null;
    job.lastRunAt = completedAt;
    job.lastStatus = "ok";
    job.lastError = null;
    job.lastDurationMs = durationMs;
    job.consecutiveErrors = 0;
    job.runCount = (job.runCount || 0) + 1;
    job.updatedAt = completedAt;

    // Handle one-shot: disable after successful run
    if (job.schedule.kind === "at" || job.deleteAfterRun) {
      job.enabled = false;
    }

    saveJob(job);

    saveRun({
      jobId: job.id, startedAt, completedAt,
      status: "ok", durationMs, resultPreview: preview, taskId,
      retryAttempt,
    });

    pruneRuns(job.id, 2000);

    eventBus.emitEvent("cron:completed", {
      jobId: job.id, name: job.name, status: "ok", durationMs,
    });

    console.log(`[CronExecutor] ✓ "${job.name}" completed in ${Math.round(durationMs / 1000)}s`);
    if (onComplete) onComplete(job);

  } catch (error) {
    // ── Failure ───────────────────────────────────────────────────────────
    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

    job.runningSince = null;
    job.lastRunAt = completedAt;
    job.lastStatus = "error";
    job.lastError = error.message;
    job.lastDurationMs = durationMs;
    job.consecutiveErrors = (job.consecutiveErrors || 0) + 1;
    job.runCount = (job.runCount || 0) + 1;
    job.updatedAt = completedAt;
    saveJob(job);

    saveRun({
      jobId: job.id, startedAt, completedAt,
      status: "error", durationMs, error: error.message, taskId, retryAttempt,
    });

    console.log(`[CronExecutor] ✗ "${job.name}" failed: ${error.message}`);

    eventBus.emitEvent("cron:failed", {
      jobId: job.id, name: job.name, error: error.message, retryAttempt,
    });

    // ── Retry ─────────────────────────────────────────────────────────────
    if (retryAttempt < (job.maxRetries || 0)) {
      const backoff = (job.retryBackoffMs || 30000) * Math.pow(2, retryAttempt);
      console.log(`[CronExecutor] Retrying "${job.name}" in ${Math.round(backoff / 1000)}s (attempt ${retryAttempt + 1}/${job.maxRetries})`);
      setTimeout(() => {
        executeJob(job, { isRetry: true, retryAttempt: retryAttempt + 1, onComplete });
      }, backoff);
      return;
    }

    // ── Failure alert ─────────────────────────────────────────────────────
    await _sendFailureAlert(job, error.message);

    if (onComplete) onComplete(job);
  }
}

/**
 * Send failure alert if cooldown elapsed.
 */
async function _sendFailureAlert(job, errorMsg) {
  const alert = job.failureAlert;
  if (!alert || alert === false) return;

  const threshold = alert.after || 3;
  if (job.consecutiveErrors < threshold) return;

  const cooldownMs = alert.cooldownMs || 3600000;
  if (job.lastFailureAlertAt) {
    const elapsed = Date.now() - new Date(job.lastFailureAlertAt).getTime();
    if (elapsed < cooldownMs) return;
  }

  job.lastFailureAlertAt = new Date().toISOString();
  saveJob(job);

  const alertText = `⚠️ **Cron Alert: ${job.name}**\n\nFailed ${job.consecutiveErrors} times in a row.\nLast error: ${errorMsg}`;

  // Send alert to configured channel
  if (alert.channel && alert.channelMeta) {
    try {
      const ch = channelRegistry.get(alert.channel) || channelRegistry.get(alert.channel, alert.channelMeta.instanceKey);
      if (ch?.running) await ch.sendReply(alert.channelMeta, alertText);
    } catch {}
  }

  console.log(`[CronExecutor] Alert sent for "${job.name}" (${job.consecutiveErrors} consecutive failures)`);
}

function _recordFailure(job, errorMsg, retryAttempt) {
  const now = new Date().toISOString();
  job.runningSince = null;
  job.lastRunAt = now;
  job.lastStatus = "error";
  job.lastError = errorMsg;
  job.consecutiveErrors = (job.consecutiveErrors || 0) + 1;
  job.runCount = (job.runCount || 0) + 1;
  job.updatedAt = now;
  saveJob(job);

  saveRun({
    jobId: job.id, startedAt: now, completedAt: now,
    status: "timeout", error: errorMsg, retryAttempt,
  });
}
