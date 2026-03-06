import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { config } from "../config/default.js";
import taskQueue from "../core/TaskQueue.js";
import eventBus from "../core/EventBus.js";

/**
 * Heartbeat - periodic proactive agent turns.
 *
 * Reads HEARTBEAT.md for user-defined instructions. Every N minutes,
 * enqueues a heartbeat task with the HEARTBEAT.md content as prompt.
 *
 * Features:
 * - Active hours: skip runs outside configurable window (default 8-22)
 * - Duplicate suppression: skip if HEARTBEAT.md unchanged within 24h
 * - Configurable via env vars or config
 */

class Heartbeat {
  constructor() {
    this.timer = null;
    this.running = false;
    this.heartbeatPath = join(config.rootDir, "HEARTBEAT.md");
    this.intervalMinutes = config.heartbeatIntervalMinutes;
    this.lastCheck = null;
    this.checkCount = 0;
    this._lastContentHash = null;
    this._lastContentAt = 0;

    // Active hours config (env override or defaults)
    this.activeHourStart = parseInt(process.env.HEARTBEAT_ACTIVE_START || "8", 10);
    this.activeHourEnd = parseInt(process.env.HEARTBEAT_ACTIVE_END || "22", 10);
  }

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
      `[Heartbeat] Started (every ${this.intervalMinutes}min, active ${this.activeHourStart}:00-${this.activeHourEnd}:00)`
    );

    // Run first check after 1 minute
    setTimeout(() => this.check(), 60000);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log(`[Heartbeat] Stopped`);
  }

  _isActiveHour() {
    const hour = new Date().getHours();
    return hour >= this.activeHourStart && hour < this.activeHourEnd;
  }

  _simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash;
  }

  async check() {
    if (!this.running) return;

    // Active hours check
    if (!this._isActiveHour()) {
      console.log(`[Heartbeat] Outside active hours (${this.activeHourStart}:00-${this.activeHourEnd}:00) — skipping`);
      return;
    }

    if (!existsSync(this.heartbeatPath)) return;

    try {
      const instructions = readFileSync(this.heartbeatPath, "utf-8").trim();
      if (!instructions) {
        console.log(`[Heartbeat] HEARTBEAT.md is empty — skipping`);
        return;
      }

      // Duplicate suppression: skip if same content within 24h
      const contentHash = this._simpleHash(instructions);
      const now = Date.now();
      if (contentHash === this._lastContentHash && (now - this._lastContentAt) < 24 * 60 * 60 * 1000) {
        console.log(`[Heartbeat] HEARTBEAT.md unchanged within 24h — skipping`);
        return;
      }
      this._lastContentHash = contentHash;
      this._lastContentAt = now;

      this.checkCount++;
      this.lastCheck = new Date().toISOString();

      console.log(`[Heartbeat] Check #${this.checkCount}...`);

      const prompt = `[Heartbeat check #${this.checkCount}] Follow the instructions in HEARTBEAT.md. If everything looks fine, respond "All clear." If something needs attention, describe what you found and take action.

Instructions from HEARTBEAT.md:
${instructions}

Current time: ${new Date().toISOString()}`;

      taskQueue.enqueue({
        input: prompt,
        channel: "heartbeat",
        sessionId: "heartbeat",
        priority: 2,
        type: "heartbeat",
      });

      eventBus.emitEvent("heartbeat:check", {
        checkNumber: this.checkCount,
      });
    } catch (error) {
      console.log(`[Heartbeat] Error: ${error.message}`);
    }
  }

  stats() {
    return {
      running: this.running,
      intervalMinutes: this.intervalMinutes,
      activeHours: `${this.activeHourStart}:00-${this.activeHourEnd}:00`,
      lastCheck: this.lastCheck,
      checkCount: this.checkCount,
    };
  }
}

const heartbeat = new Heartbeat();
export default heartbeat;
