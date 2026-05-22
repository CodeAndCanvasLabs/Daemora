/**
 * Phase 5: CostGuard tests.
 *
 *  - daily cap: capped after spending hits the cap
 *  - task cap: capped after task spending hits the cap
 *  - no cap when env unset (single-tenant pass-through)
 *  - estimate flag: refuses pre-call when next call would exceed
 */

import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";

import { CostTracker } from "../src/costs/CostTracker.js";
import { CostCapExceededError, CostGuard } from "../src/costs/CostGuard.js";

function freshTracker(): CostTracker {
  return new CostTracker(new Database(":memory:"));
}

describe("CostGuard — daily cap", () => {
  let tracker: CostTracker;
  beforeEach(() => { tracker = freshTracker(); });

  it("allows calls under the daily cap", () => {
    const guard = new CostGuard({ maxDailyUsd: 1.0, maxPerTaskUsd: 0, tracker });
    expect(() => guard.beforeCall("task-1")).not.toThrow();
  });

  it("blocks once daily total reaches the cap", () => {
    const guard = new CostGuard({ maxDailyUsd: 0.50, maxPerTaskUsd: 0, tracker });
    // Record enough usage to cross the cap.
    tracker.record("task-1", "claude-sonnet-4-20250514", "anthropic", 100_000, 100_000);  // ~$1+
    expect(() => guard.beforeCall("task-1")).toThrow(CostCapExceededError);
  });

  it("error names the scope and the cap value", () => {
    const guard = new CostGuard({ maxDailyUsd: 0.10, maxPerTaskUsd: 0, tracker });
    tracker.record("task-1", "claude-sonnet-4-20250514", "anthropic", 50_000, 50_000);
    try {
      guard.beforeCall("task-1");
      throw new Error("expected to throw");
    } catch (e) {
      const err = e as CostCapExceededError;
      expect(err.scope).toBe("daily");
      expect(err.capUsd).toBe(0.10);
      expect(err.spentUsd).toBeGreaterThanOrEqual(0.10);
    }
  });

  it("respects an estimate when caller passes one (catches before crossing)", () => {
    const guard = new CostGuard({ maxDailyUsd: 1.0, maxPerTaskUsd: 0, tracker });
    // Spend $0.40 already.
    tracker.record("task-1", "claude-sonnet-4-20250514", "anthropic", 20_000, 20_000);  // ~$0.40 at sonnet rates
    // Next call estimated at $1.0 — would push over $1.40, exceeds $1 cap.
    expect(() => guard.beforeCall("task-1", 1.0)).toThrow(CostCapExceededError);
  });
});

describe("CostGuard — per-task cap", () => {
  let tracker: CostTracker;
  beforeEach(() => { tracker = freshTracker(); });

  it("blocks once a single task crosses its cap", () => {
    const guard = new CostGuard({ maxDailyUsd: 0, maxPerTaskUsd: 0.20, tracker });
    tracker.record("task-A", "claude-sonnet-4-20250514", "anthropic", 20_000, 20_000);
    expect(() => guard.beforeCall("task-A")).toThrow(CostCapExceededError);
  });

  it("only blocks the offending task — other tasks still pass", () => {
    const guard = new CostGuard({ maxDailyUsd: 0, maxPerTaskUsd: 0.20, tracker });
    tracker.record("task-A", "claude-sonnet-4-20250514", "anthropic", 20_000, 20_000);
    expect(() => guard.beforeCall("task-A")).toThrow(CostCapExceededError);
    expect(() => guard.beforeCall("task-B")).not.toThrow();
  });
});

describe("CostGuard — env construction", () => {
  it("returns undefined when no caps are set", () => {
    const tracker = freshTracker();
    expect(CostGuard.fromEnv(tracker, {})).toBeUndefined();
  });

  it("constructs from env when caps are set", () => {
    const tracker = freshTracker();
    const guard = CostGuard.fromEnv(tracker, {
      DAEMORA_MAX_DAILY_COST: "5.00",
      DAEMORA_MAX_COST_PER_TASK: "1.00",
    });
    expect(guard).toBeDefined();
    expect(guard?.snapshot().dailyCapUsd).toBe(5);
    expect(guard?.snapshot().taskCapUsd).toBe(1);
  });

  it("treats negative/garbage caps as unlimited (rejects unsafe input)", () => {
    const tracker = freshTracker();
    const guard = CostGuard.fromEnv(tracker, {
      DAEMORA_MAX_DAILY_COST: "-5",
      DAEMORA_MAX_COST_PER_TASK: "abc",
    });
    expect(guard).toBeUndefined();
  });
});

describe("CostGuard — no-cap pass-through", () => {
  it("never throws when both caps are 0", () => {
    const tracker = freshTracker();
    const guard = new CostGuard({ maxDailyUsd: 0, maxPerTaskUsd: 0, tracker });
    tracker.record("task-1", "claude-sonnet-4-20250514", "anthropic", 1_000_000, 1_000_000);
    expect(() => guard.beforeCall("task-1")).not.toThrow();
    expect(() => guard.beforeCall("task-1", 9999)).not.toThrow();
  });
});
