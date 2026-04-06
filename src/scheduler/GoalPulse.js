/**
 * GoalPulse - periodic autonomous goal execution.
 *
 * Every 60s, checks for due goals and enqueues them as tasks.
 * Goals auto-pause after consecutive failures.
 */

class GoalPulse {
  constructor() {
    this.timer = null;
    this.running = false;
    this.checkCount = 0;
    this.lastCheck = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.check().catch(e => console.log(`[GoalPulse] Error: ${e.message}`)), 60_000);
    console.log("[GoalPulse] Started - checking goals every 60s");
  }

  async check() {
    const { loadDueGoals, saveGoal } = await import("../storage/GoalStore.js");
    const dueGoals = loadDueGoals();
    if (dueGoals.length === 0) return;

    this.checkCount++;
    this.lastCheck = new Date().toISOString();

    for (const goal of dueGoals) {
      try {
        await this._executeGoal(goal);
      } catch (e) {
        console.log(`[GoalPulse] Goal "${goal.title}" failed: ${e.message}`);
        goal.consecutiveFailures = (goal.consecutiveFailures || 0) + 1;
        if (goal.consecutiveFailures >= (goal.maxFailures || 3)) {
          goal.status = "paused";
          console.log(`[GoalPulse] Goal "${goal.title}" auto-paused after ${goal.consecutiveFailures} failures`);
        }
        goal.lastCheckAt = new Date().toISOString();
        goal.updatedAt = new Date().toISOString();
        saveGoal(goal);
      }
    }
  }

  async _executeGoal(goal) {
    const taskQueue = (await import("../core/TaskQueue.js")).default;
    const { saveGoal } = await import("../storage/GoalStore.js");

    // Build goal prompt
    const lines = [
      "[Goal Check] You are executing an autonomous goal. No user present.",
      `Goal: ${goal.title}`,
      goal.description ? `Description: ${goal.description}` : null,
      goal.strategy ? `Strategy: ${goal.strategy}` : null,
      goal.lastResult ? `[Last check result: ${goal.lastResult.slice(0, 300)}]` : null,
      "",
      "Execute progress toward this goal. Report what you accomplished.",
    ].filter(Boolean).join("\n");

    // Enqueue
    const sessionId = `goal:${goal.id.slice(0, 8)}:${Date.now()}`;
    taskQueue.enqueue({
      input: lines,
      channel: goal.delivery?.channel || "goal",
      channelMeta: goal.delivery?.channelMeta || null,
      model: null,
      sessionId,
      priority: 3,
      type: "goal",
    });

    // Compute next check from cron expression
    const { Cron } = await import("croner");
    const expr = goal.checkCron || "0 */4 * * *";
    const cronInstance = new Cron(expr, { timezone: goal.checkTz || undefined });
    const nextRun = cronInstance.nextRun();

    goal.lastCheckAt = new Date().toISOString();
    goal.nextCheckAt = nextRun ? nextRun.toISOString() : null;
    goal.consecutiveFailures = 0;
    goal.updatedAt = new Date().toISOString();
    saveGoal(goal);

    console.log(`[GoalPulse] Enqueued goal "${goal.title}" (next: ${goal.nextCheckAt || "none"})`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
    console.log("[GoalPulse] Stopped");
  }

  stats() {
    return { running: this.running, checkCount: this.checkCount, lastCheck: this.lastCheck };
  }
}

const goalPulse = new GoalPulse();
export default goalPulse;
