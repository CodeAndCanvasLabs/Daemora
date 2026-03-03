import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { config } from "../config/default.js";
import taskQueue from "../core/TaskQueue.js";
import eventBus from "../core/EventBus.js";

/**
 * Heartbeat - periodic proactive check.
 *
 * Reads HEARTBEAT.md for user-defined checks.
 * Every N minutes, creates a task: "Check status per HEARTBEAT.md"
 * If nothing notable → "All clear" (no notification).
 * If something needs attention → sends result to configured channel.
 */

class Heartbeat {
  constructor() {
    this.timer = null;
    this.running = false;
    this.heartbeatPath = join(config.rootDir, "HEARTBEAT.md");
    this.intervalMinutes = config.heartbeatIntervalMinutes;
    this.lastCheck = null;
    this.checkCount = 0;
  }

  /**
   * Start the heartbeat.
   */
  start() {
    if (!config.daemonMode) {
      console.log(`[Heartbeat] Skipped - daemon mode not enabled`);
      return;
    }

    if (!existsSync(this.heartbeatPath)) {
      console.log(`[Heartbeat] No HEARTBEAT.md found - heartbeat disabled`);
      return;
    }

    this.running = true;
    this.timer = setInterval(
      () => this.check(),
      this.intervalMinutes * 60 * 1000
    );

    console.log(
      `[Heartbeat] Started (every ${this.intervalMinutes} minutes)`
    );

    // Run first check after 1 minute
    setTimeout(() => this.check(), 60000);
  }

  /**
   * Stop the heartbeat.
   */
  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log(`[Heartbeat] Stopped`);
  }

  /**
   * Run a heartbeat check.
   */
  async check() {
    if (!this.running) return;

    try {
      const instructions = readFileSync(this.heartbeatPath, "utf-8");
      this.checkCount++;
      this.lastCheck = new Date().toISOString();

      console.log(`[Heartbeat] Check #${this.checkCount}...`);

      const prompt = `You are running a periodic heartbeat check. Review the following instructions and check each item. If everything looks fine, just respond "All clear." If something needs attention, describe what you found.

Instructions from HEARTBEAT.md:
${instructions}

Current time: ${new Date().toISOString()}`;

      taskQueue.enqueue({
        input: prompt,
        channel: "heartbeat",
        sessionId: null,
        priority: 2,
      });

      eventBus.emitEvent("heartbeat:check", {
        checkNumber: this.checkCount,
      });
    } catch (error) {
      console.log(`[Heartbeat] Error: ${error.message}`);
    }
  }

  /**
   * Get stats.
   */
  stats() {
    return {
      running: this.running,
      intervalMinutes: this.intervalMinutes,
      lastCheck: this.lastCheck,
      checkCount: this.checkCount,
    };
  }
}

const heartbeat = new Heartbeat();
export default heartbeat;
