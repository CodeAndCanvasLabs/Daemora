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
import tenantContext from "../tenants/TenantContext.js";
import tenantManager from "../tenants/TenantManager.js";
import channelRegistry from "../channels/index.js";
import { loadPreset } from "./DeliveryPresetStore.js";
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
      console.log(`[CronExecutor] Skipping "${job.name}" — already running since ${job.runningSince}`);
      saveRun({
        jobId: job.id, tenantId: job.tenantId, startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(), status: "skipped",
        error: "Skipped: previous run still active", retryAttempt,
      });
      return;
    }
    // Stuck — force-clear and proceed
    console.log(`[CronExecutor] Clearing stuck job "${job.name}" (running ${Math.round(stuckMs / 1000)}s)`);
    _recordFailure(job, "Job timed out — cleared stuck state", retryAttempt);
  }

  // ── Mark as running ───────────────────────────────────────────────────────
  const runId = uuidv4();
  const startedAt = new Date().toISOString();
  job.runningSince = startedAt;
  saveJob(job);

  const sessionId = `cron:${job.id.slice(0, 8)}:${runId.slice(0, 8)}`;
  let taskId = null;

  console.log(`[CronExecutor] Running "${job.name}"${isRetry ? ` (retry #${retryAttempt})` : ""}`);

  try {
    // ── Resolve tenant context ────────────────────────────────────────────
    let resolvedConfig = {};
    let tenant = null;
    let apiKeys = {};

    if (job.tenantId) {
      tenant = tenantManager.get(job.tenantId);
      if (tenant) {
        resolvedConfig = tenantManager.resolveTaskConfig(tenant);
        apiKeys = resolvedConfig.apiKeys || {};
      }
    }

    // ── Enqueue task ──────────────────────────────────────────────────────
    const enqueuedTask = taskQueue.enqueue({
      input: job.taskInput,
      channel: job.delivery?.channel || "cron",
      channelMeta: job.delivery?.channelMeta || null,
      model: job.model || resolvedConfig.model || null,
      sessionId,
      priority: 3,
      type: "cron",
      tenantId: job.tenantId,
    });
    taskId = enqueuedTask.id;

    // ── Wait for completion ───────────────────────────────────────────────
    const timeoutMs = (job.timeoutSeconds || 7200) * 1000;
    const result = await taskQueue.waitForCompletion(taskId, timeoutMs);
    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

    // ── Success ───────────────────────────────────────────────────────────
    const resultText = typeof result === "string" ? result : (result?.text || JSON.stringify(result) || "");
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

    // ── Delivery ──────────────────────────────────────────────────────────
    const deliveryResult = await _deliver(job, resultText);

    saveRun({
      jobId: job.id, tenantId: job.tenantId, startedAt, completedAt,
      status: "ok", durationMs, resultPreview: preview, taskId,
      deliveryStatus: deliveryResult.status,
      deliveryError: deliveryResult.error,
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
      jobId: job.id, tenantId: job.tenantId, startedAt, completedAt,
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
 * Deliver job result — supports single channel, multi-target fan-out, preset, and webhook.
 */
async function _deliver(job, resultText) {
  const mode = job.delivery?.mode;
  if (!mode || mode === "none") return { status: "not-requested" };

  const text = `📋 **Cron: ${job.name}**\n\n${resultText}`;

  try {
    // Legacy single-target announce (backward compat)
    if (mode === "announce" && !job.delivery.targets && !job.delivery.presetId) {
      const meta = _freshMeta(job.delivery.channel, job.delivery.channelMeta, null);
      return await _deliverSingle(job.delivery.channel, meta, text);
    }

    // Multi-target fan-out (inline targets)
    if (mode === "multi" && job.delivery.targets?.length) {
      return await _fanOut(job.delivery.targets, text, job.name);
    }

    // Preset-based fan-out
    if (mode === "preset" && job.delivery.presetId) {
      const preset = loadPreset(job.delivery.presetId);
      if (!preset || !preset.targets?.length) {
        return { status: "not-delivered", error: `Preset "${job.delivery.presetId}" not found or empty` };
      }
      return await _fanOut(preset.targets, text, job.name);
    }

    // Webhook
    if (mode === "webhook" && job.delivery.to) {
      const resp = await fetch(job.delivery.to, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: job.id, jobName: job.name, status: "ok",
          result: resultText, timestamp: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) throw new Error(`Webhook ${resp.status}: ${resp.statusText}`);
      return { status: "delivered" };
    }

    return { status: "not-delivered", error: "Delivery config incomplete" };
  } catch (e) {
    console.log(`[CronExecutor] Delivery failed for "${job.name}": ${e.message}`);
    return { status: "not-delivered", error: e.message };
  }
}

/**
 * Fan-out delivery to multiple targets. Runs all in parallel, no short-circuit.
 */
async function _fanOut(targets, text, jobName) {
  const results = await Promise.allSettled(
    targets.map(t => {
      const meta = _freshMeta(t.channel, t.channelMeta, t.tenantId, t.userId);
      return _deliverSingle(t.channel, meta, text);
    })
  );

  const delivered = results.filter(r => r.status === "fulfilled" && r.value?.status === "delivered").length;
  const failed = results.length - delivered;
  const errors = results
    .filter(r => r.status === "rejected" || r.value?.status === "not-delivered")
    .map(r => r.reason?.message || r.value?.error)
    .filter(Boolean);

  const status = failed === 0 ? "delivered" : delivered > 0 ? "partial" : "not-delivered";
  console.log(`[CronExecutor] Delivery "${jobName}": ${delivered}/${results.length} delivered${errors.length ? ` (errors: ${errors.join("; ")})` : ""}`);

  return {
    status,
    delivered,
    failed,
    total: results.length,
    error: errors.length ? errors.join("; ") : null,
  };
}

/**
 * Deliver to a single channel via channelRegistry.sendReply().
 */
async function _deliverSingle(channelType, channelMeta, text) {
  if (!channelType || !channelMeta) {
    return { status: "not-delivered", error: `Missing channel or meta for ${channelType}` };
  }

  // Find channel — try tenant instance first, then global
  const instanceKey = channelMeta.instanceKey || null;
  const channel = channelRegistry.get(channelType, instanceKey) || channelRegistry.get(channelType);

  if (!channel || !channel.running) {
    return { status: "not-delivered", error: `Channel "${channelType}" not running` };
  }

  try {
    await channel.sendReply(channelMeta, text);
    return { status: "delivered" };
  } catch (e) {
    return { status: "not-delivered", error: `${channelType}: ${e.message}` };
  }
}

/**
 * Resolve fresh channelMeta from tenant_channels at delivery time.
 * Prevents stale routing metadata — always uses current data.
 */
function _freshMeta(channelType, fallbackMeta, tenantId, userId) {
  if (!tenantId) return fallbackMeta; // global channel — use stored meta
  try {
    const channels = tenantManager.getChannels(tenantId);
    const match = channels.find(c =>
      c.channel === channelType && (!userId || c.user_id === userId)
    );
    return match?.meta || fallbackMeta;
  } catch {
    return fallbackMeta;
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

  // Try direct channel delivery instead of dead event
  if (alert.channel && alert.channelMeta) {
    await _deliverSingle(alert.channel, alert.channelMeta, alertText);
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
    jobId: job.id, tenantId: job.tenantId, startedAt: now, completedAt: now,
    status: "timeout", error: errorMsg, retryAttempt,
  });
}
