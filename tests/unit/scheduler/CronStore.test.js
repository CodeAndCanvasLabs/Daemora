import { describe, it, expect, afterEach } from "vitest";
import { saveJob, loadJob, loadAllJobs, deleteJob, saveRun, loadRuns } from "../../../src/scheduler/CronStore.js";
import { v4 as uuidv4 } from "uuid";

const testJobIds = [];

afterEach(() => {
  for (const id of testJobIds) {
    try { deleteJob(id); } catch {}
  }
  testJobIds.length = 0;
});

describe("CronStore", () => {
  const makeJob = (overrides = {}) => {
    const id = uuidv4();
    testJobIds.push(id);
    return {
      id,
      tenantId: null,
      name: `Test Job ${id.slice(0, 8)}`,
      description: "test",
      enabled: true,
      deleteAfterRun: false,
      schedule: { kind: "cron", expr: "0 9 * * *", tz: null, everyMs: null, at: null, staggerMs: 0 },
      taskInput: "test task",
      model: null,
      thinking: null,
      timeoutSeconds: 7200,
      delivery: { mode: "none", channel: null, to: null, channelMeta: null, targets: null, presetId: null },
      maxRetries: 0,
      retryBackoffMs: 30000,
      failureAlert: null,
      nextRunAt: null,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      lastDurationMs: null,
      consecutiveErrors: 0,
      runCount: 0,
      runningSince: null,
      lastFailureAlertAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  };

  it("saves and loads a job", () => {
    const job = makeJob();
    saveJob(job);
    const loaded = loadJob(job.id);
    expect(loaded).toBeTruthy();
    expect(loaded.name).toBe(job.name);
    expect(loaded.schedule.kind).toBe("cron");
    expect(loaded.schedule.expr).toBe("0 9 * * *");
  });

  it("saves delivery_targets JSON", () => {
    const targets = [{ tenantId: "t:1", channel: "telegram", userId: "1" }];
    const job = makeJob({ delivery: { mode: "multi", targets, channel: null, to: null, channelMeta: null, presetId: null } });
    saveJob(job);
    const loaded = loadJob(job.id);
    expect(loaded.delivery.mode).toBe("multi");
    expect(loaded.delivery.targets).toHaveLength(1);
    expect(loaded.delivery.targets[0].tenantId).toBe("t:1");
  });

  it("saves delivery_preset_id", () => {
    const job = makeJob({ delivery: { mode: "preset", presetId: "abc123", channel: null, to: null, channelMeta: null, targets: null } });
    saveJob(job);
    const loaded = loadJob(job.id);
    expect(loaded.delivery.presetId).toBe("abc123");
  });

  it("loads all jobs with tenant filter", () => {
    const j1 = makeJob({ tenantId: "tenant:test1" });
    const j2 = makeJob({ tenantId: "tenant:test2" });
    saveJob(j1);
    saveJob(j2);

    const all = loadAllJobs();
    expect(all.length).toBeGreaterThanOrEqual(2);

    const filtered = loadAllJobs("tenant:test1");
    expect(filtered.some(j => j.id === j1.id)).toBe(true);
    expect(filtered.some(j => j.id === j2.id)).toBe(false);
  });

  it("deletes a job", () => {
    const job = makeJob();
    saveJob(job);
    deleteJob(job.id);
    expect(loadJob(job.id)).toBeNull();
  });

  it("saves and loads run history", () => {
    const job = makeJob();
    saveJob(job);

    saveRun({
      jobId: job.id,
      tenantId: null,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: "ok",
      durationMs: 1234,
      resultPreview: "test result",
      taskId: "task-123",
      deliveryStatus: "delivered",
      deliveryError: null,
      retryAttempt: 0,
    });

    const runs = loadRuns(job.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
  });
});
