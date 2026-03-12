/**
 * CronStore - SQLite persistence for cron jobs and run history.
 *
 * Tables: cron_jobs, cron_runs (created in Database.js migration).
 * Follows TaskStore.js pattern: pure functions, import DB helpers.
 */
import { queryAll, queryOne, run } from "../storage/Database.js";

// ── Jobs ──────────────────────────────────────────────────────────────────────

export function saveJob(job) {
  run(
    `INSERT INTO cron_jobs (
      id, tenant_id, name, description, enabled, delete_after_run,
      schedule_kind, cron_expr, cron_tz, every_ms, at_time, stagger_ms,
      task_input, model, thinking, timeout_seconds,
      delivery_mode, delivery_channel, delivery_to, delivery_channel_meta,
      max_retries, retry_backoff_ms, failure_alert,
      next_run_at, last_run_at, last_status, last_error, last_duration_ms,
      consecutive_errors, run_count, running_since, last_failure_alert_at,
      created_at, updated_at
    ) VALUES (
      $id, $tenantId, $name, $desc, $enabled, $deleteAfterRun,
      $kind, $expr, $tz, $everyMs, $atTime, $staggerMs,
      $input, $model, $thinking, $timeout,
      $delMode, $delChannel, $delTo, $delMeta,
      $retries, $backoff, $failAlert,
      $nextRun, $lastRun, $lastStatus, $lastError, $lastDuration,
      $consErrors, $runCount, $runningSince, $lastAlertAt,
      $createdAt, $updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      tenant_id=$tenantId, name=$name, description=$desc, enabled=$enabled,
      delete_after_run=$deleteAfterRun,
      schedule_kind=$kind, cron_expr=$expr, cron_tz=$tz, every_ms=$everyMs,
      at_time=$atTime, stagger_ms=$staggerMs,
      task_input=$input, model=$model, thinking=$thinking, timeout_seconds=$timeout,
      delivery_mode=$delMode, delivery_channel=$delChannel, delivery_to=$delTo,
      delivery_channel_meta=$delMeta,
      max_retries=$retries, retry_backoff_ms=$backoff, failure_alert=$failAlert,
      next_run_at=$nextRun, last_run_at=$lastRun, last_status=$lastStatus,
      last_error=$lastError, last_duration_ms=$lastDuration,
      consecutive_errors=$consErrors, run_count=$runCount,
      running_since=$runningSince, last_failure_alert_at=$lastAlertAt,
      updated_at=$updatedAt`,
    {
      $id: job.id,
      $tenantId: job.tenantId || null,
      $name: job.name,
      $desc: job.description || null,
      $enabled: job.enabled ? 1 : 0,
      $deleteAfterRun: job.deleteAfterRun ? 1 : 0,
      $kind: job.schedule.kind,
      $expr: job.schedule.expr || null,
      $tz: job.schedule.tz || null,
      $everyMs: job.schedule.everyMs || null,
      $atTime: job.schedule.at || null,
      $staggerMs: job.schedule.staggerMs || 0,
      $input: job.taskInput,
      $model: job.model || null,
      $thinking: job.thinking || null,
      $timeout: job.timeoutSeconds ?? 7200,
      $delMode: job.delivery?.mode || "none",
      $delChannel: job.delivery?.channel || null,
      $delTo: job.delivery?.to || null,
      $delMeta: job.delivery?.channelMeta ? JSON.stringify(job.delivery.channelMeta) : null,
      $retries: job.maxRetries ?? 0,
      $backoff: job.retryBackoffMs ?? 30000,
      $failAlert: job.failureAlert ? JSON.stringify(job.failureAlert) : null,
      $nextRun: job.nextRunAt || null,
      $lastRun: job.lastRunAt || null,
      $lastStatus: job.lastStatus || null,
      $lastError: job.lastError || null,
      $lastDuration: job.lastDurationMs || null,
      $consErrors: job.consecutiveErrors ?? 0,
      $runCount: job.runCount ?? 0,
      $runningSince: job.runningSince || null,
      $lastAlertAt: job.lastFailureAlertAt || null,
      $createdAt: job.createdAt || new Date().toISOString(),
      $updatedAt: job.updatedAt || new Date().toISOString(),
    }
  );
}

export function loadJob(id) {
  const row = queryOne("SELECT * FROM cron_jobs WHERE id = $id", { $id: id });
  return row ? _rowToJob(row) : null;
}

export function loadAllJobs(tenantId = null) {
  const rows = tenantId
    ? queryAll("SELECT * FROM cron_jobs WHERE tenant_id = $tid ORDER BY created_at DESC", { $tid: tenantId })
    : queryAll("SELECT * FROM cron_jobs ORDER BY created_at DESC");
  return rows.map(_rowToJob);
}

export function deleteJob(id) {
  run("DELETE FROM cron_jobs WHERE id = $id", { $id: id });
}

// ── Runs ──────────────────────────────────────────────────────────────────────

export function saveRun(r) {
  run(
    `INSERT INTO cron_runs (
      job_id, tenant_id, started_at, completed_at, status, duration_ms,
      error, result_preview, task_id, delivery_status, delivery_error,
      retry_attempt, cost
    ) VALUES ($jid, $tid, $start, $end, $status, $dur, $err, $preview, $taskId, $delSt, $delErr, $retry, $cost)`,
    {
      $jid: r.jobId,
      $tid: r.tenantId || null,
      $start: r.startedAt,
      $end: r.completedAt || null,
      $status: r.status,
      $dur: r.durationMs || null,
      $err: r.error || null,
      $preview: r.resultPreview || null,
      $taskId: r.taskId || null,
      $delSt: r.deliveryStatus || "not-requested",
      $delErr: r.deliveryError || null,
      $retry: r.retryAttempt ?? 0,
      $cost: r.cost ? JSON.stringify(r.cost) : null,
    }
  );
}

export function loadRuns(jobId, { limit = 50, offset = 0, status = null } = {}) {
  const where = status
    ? "WHERE job_id = $jid AND status = $status"
    : "WHERE job_id = $jid";
  const params = status
    ? { $jid: jobId, $status: status, $limit: limit, $offset: offset }
    : { $jid: jobId, $limit: limit, $offset: offset };
  return queryAll(
    `SELECT * FROM cron_runs ${where} ORDER BY started_at DESC LIMIT $limit OFFSET $offset`,
    params
  );
}

export function loadAllRuns({ tenantId = null, limit = 50, offset = 0, status = null } = {}) {
  let where = "WHERE 1=1";
  const params = { $limit: limit, $offset: offset };
  if (tenantId) { where += " AND tenant_id = $tid"; params.$tid = tenantId; }
  if (status) { where += " AND status = $status"; params.$status = status; }
  return queryAll(
    `SELECT * FROM cron_runs ${where} ORDER BY started_at DESC LIMIT $limit OFFSET $offset`,
    params
  );
}

export function pruneRuns(jobId, maxCount = 2000) {
  const count = queryOne("SELECT COUNT(*) as cnt FROM cron_runs WHERE job_id = $jid", { $jid: jobId });
  if (count && count.cnt > maxCount) {
    run(
      `DELETE FROM cron_runs WHERE job_id = $jid AND id NOT IN (
        SELECT id FROM cron_runs WHERE job_id = $jid ORDER BY started_at DESC LIMIT $max
      )`,
      { $jid: jobId, $max: maxCount }
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _rowToJob(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    enabled: !!row.enabled,
    deleteAfterRun: !!row.delete_after_run,
    schedule: {
      kind: row.schedule_kind,
      expr: row.cron_expr,
      tz: row.cron_tz,
      everyMs: row.every_ms,
      at: row.at_time,
      staggerMs: row.stagger_ms || 0,
    },
    taskInput: row.task_input,
    model: row.model,
    thinking: row.thinking,
    timeoutSeconds: row.timeout_seconds ?? 7200,
    delivery: {
      mode: row.delivery_mode || "none",
      channel: row.delivery_channel,
      to: row.delivery_to,
      channelMeta: row.delivery_channel_meta ? JSON.parse(row.delivery_channel_meta) : null,
    },
    maxRetries: row.max_retries ?? 0,
    retryBackoffMs: row.retry_backoff_ms ?? 30000,
    failureAlert: row.failure_alert ? JSON.parse(row.failure_alert) : null,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastDurationMs: row.last_duration_ms,
    consecutiveErrors: row.consecutive_errors ?? 0,
    runCount: row.run_count ?? 0,
    runningSince: row.running_since,
    lastFailureAlertAt: row.last_failure_alert_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
