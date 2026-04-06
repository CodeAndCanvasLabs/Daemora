import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { config } from "../config/default.js";
import taskQueue from "../core/TaskQueue.js";
import eventBus from "../core/EventBus.js";
import { queryAll, queryOne } from "../storage/Database.js";
import { runDecayCycle } from "../learning/MemoryDecay.js";

/**
 * Heartbeat - proactive self-check + user-defined heartbeat instructions.
 *
 * Two modes combined:
 * 1. HEARTBEAT.md: user-written instructions (backwards compatible)
 * 2. Proactive checks: system health - overdue goals, broken cron, silent watchers
 *
 * If something needs attention → enqueues a proactive task with findings.
 * If nothing found → silent (no wasted tokens).
 *
 * Pattern: OpenClaw's event-aware heartbeat (HEARTBEAT_OK = nothing to report).
 *
 * Edge cases:
 * - Active hours: skip checks outside configurable window (default 8am-10pm)
 * - Cooldown: won't fire proactive checks more than once per interval
 * - HEARTBEAT.md dedup: skip if content unchanged within 24h
 * - No channels: stores results only (no delivery error)
 * - Daemon mode only for user heartbeat; proactive checks run always
 */

class Heartbeat {
  constructor() {
    this.timer = null;
    this.running = false;
    this.heartbeatPath = join(config.rootDir, "HEARTBEAT.md");
    this.intervalMinutes = config.heartbeatIntervalMinutes || 30;
    this.lastCheck = null;
    this.checkCount = 0;
    this._lastContentHash = null;
    this._lastContentAt = 0;
    this._lastProactiveAt = 0;

    // Active hours config (supports HH:MM format + timezone)
    this.activeHourStart = process.env.HEARTBEAT_ACTIVE_START || "08:00";
    this.activeHourEnd = process.env.HEARTBEAT_ACTIVE_END || "22:00";
    this.activeTimezone = process.env.HEARTBEAT_TIMEZONE || null; // IANA timezone, null = host

    // Proactive check interval (minimum gap between proactive checks)
    this.proactiveIntervalMs = (parseInt(process.env.HEARTBEAT_PROACTIVE_INTERVAL_MIN || "240", 10)) * 60 * 1000; // default 4 hours
  }

  start() {
    this.running = true;

    // Proactive checks run regardless of daemon mode
    const tickMs = Math.min(this.intervalMinutes * 60 * 1000, 5 * 60 * 1000); // check every 5min or heartbeat interval, whichever is smaller
    this.timer = setInterval(() => this._tick(), tickMs);

    const tzLabel = this.activeTimezone || "host";
    console.log(
      `[Heartbeat] Started (every ${this.intervalMinutes}min, proactive every ${this.proactiveIntervalMs / 60000}min, active ${this.activeHourStart}-${this.activeHourEnd} ${tzLabel})`
    );

    // First proactive check after 2 minutes
    setTimeout(() => this._tick(), 120_000);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log(`[Heartbeat] Stopped`);
  }

  async _tick() {
    if (!this.running) return;
    if (!this._isActiveHour()) return;

    // Run proactive system checks
    await this._proactiveCheck();

    // Run user HEARTBEAT.md (only in daemon mode)
    if (config.daemonMode) {
      await this._userHeartbeat();
    }
  }

  // ── Proactive System Checks ───────────────────────────────────────────────

  async _proactiveCheck() {
    const now = Date.now();
    if ((now - this._lastProactiveAt) < this.proactiveIntervalMs) return;

    try {
      // Run memory decay cycle (daily maintenance)
      try { runDecayCycle(); } catch (e) { console.log(`[Heartbeat] Memory decay error: ${e.message}`); }

      const findings = [];

      // 1. Overdue goals - active goals that missed their check window
      const overdueGoals = this._checkOverdueGoals();
      if (overdueGoals.length > 0) findings.push(...overdueGoals);

      // 2. Broken cron jobs - consecutive errors
      const brokenCrons = this._checkBrokenCrons();
      if (brokenCrons.length > 0) findings.push(...brokenCrons);

      // 3. Silent watchers - enabled but haven't fired when expected
      const silentWatchers = this._checkSilentWatchers();
      if (silentWatchers.length > 0) findings.push(...silentWatchers);

      // 4. Failed tasks - recent failures that might need attention
      const failedTasks = this._checkFailedTasks();
      if (failedTasks.length > 0) findings.push(...failedTasks);

      this._lastProactiveAt = now;

      // Nothing found → silent (OpenClaw HEARTBEAT_OK pattern)
      if (findings.length === 0) {
        console.log(`[Heartbeat] Proactive check: all clear`);
        return;
      }

      // Something needs attention → enqueue proactive task
      const findingsText = findings.map((f, i) => `${i + 1}. [${f.type}] ${f.message}`).join("\n");

      console.log(`[Heartbeat] Proactive check: ${findings.length} finding(s) - enqueuing task`);

      const prompt = `[Proactive Check] The system detected issues that need attention. Review each finding and take appropriate action.

FINDINGS:
${findingsText}

For each finding:
- If you can fix it, fix it (retry failed task, resume paused goal, etc.)
- If you can't fix it, notify the user via replyToUser() with a clear summary
- If it's informational only, note it and move on

If nothing actually needs action after review, respond with just "HEARTBEAT_OK".

Current time: ${new Date().toISOString()}`;

      // Resolve delivery channel - use most recent active channel
      const delivery = this._resolveDeliveryChannel();

      taskQueue.enqueue({
        input: prompt,
        channel: delivery.channel,
        channelMeta: delivery.channelMeta,
        sessionId: "heartbeat-proactive",
        priority: 2,
        type: "heartbeat",
      });

      eventBus.emitEvent("heartbeat:proactive", {
        findingCount: findings.length,
        findings: findings.map(f => f.type),
      });
    } catch (err) {
      console.log(`[Heartbeat] Proactive check error: ${err.message}`);
    }
  }

  /**
   * Check for overdue goals - active goals that missed their check window by 2x.
   */
  _checkOverdueGoals() {
    const findings = [];
    try {
      const now = new Date().toISOString();
      const goals = queryAll(
        `SELECT id, title, next_check_at, check_cron, consecutive_failures, tenant_id
         FROM goals
         WHERE status = 'active' AND next_check_at IS NOT NULL AND next_check_at < $now`,
        { $now: now }
      );

      for (const goal of goals) {
        if (!goal.next_check_at) continue;
        const overdueMs = Date.now() - new Date(goal.next_check_at).getTime();
        const overdueHours = (overdueMs / 3600000).toFixed(1);

        // Only flag if overdue by more than 1 hour (avoid noise)
        if (overdueMs > 3600000) {
          findings.push({
            type: "OVERDUE_GOAL",
            message: `Goal "${goal.title}" (${goal.id.slice(0, 8)}) is ${overdueHours}h overdue. ${goal.consecutive_failures > 0 ? `Has ${goal.consecutive_failures} consecutive failure(s).` : ""}`,
          });
        }
      }
    } catch {}
    return findings;
  }

  /**
   * Check for cron jobs with consecutive errors.
   */
  _checkBrokenCrons() {
    const findings = [];
    try {
      const jobs = queryAll(
        `SELECT id, name, consecutive_errors, last_error, last_status
         FROM cron_jobs
         WHERE enabled = 1 AND consecutive_errors >= 3`
      );

      for (const job of jobs) {
        findings.push({
          type: "BROKEN_CRON",
          message: `Cron job "${job.name || job.id.slice(0, 8)}" has ${job.consecutive_errors} consecutive errors. Last error: ${(job.last_error || "unknown").slice(0, 100)}`,
        });
      }
    } catch {}
    return findings;
  }

  /**
   * Check for enabled watchers that haven't triggered in a long time.
   * A watcher with a pattern that hasn't fired in 7+ days might indicate
   * a broken webhook integration.
   */
  _checkSilentWatchers() {
    const findings = [];
    try {
      const watchers = queryAll(
        `SELECT id, name, last_triggered_at, trigger_count, pattern
         FROM watchers
         WHERE enabled = 1 AND pattern IS NOT NULL AND trigger_count > 0`
      );

      const sevenDaysAgo = Date.now() - 7 * 24 * 3600000;
      for (const w of watchers) {
        if (!w.last_triggered_at) continue;
        const lastFired = new Date(w.last_triggered_at).getTime();
        if (lastFired < sevenDaysAgo) {
          const daysSilent = Math.floor((Date.now() - lastFired) / 86400000);
          findings.push({
            type: "SILENT_WATCHER",
            message: `Watcher "${w.name}" hasn't fired in ${daysSilent} days (previously fired ${w.trigger_count} times). The webhook source may have stopped sending events.`,
          });
        }
      }
    } catch {}
    return findings;
  }

  /**
   * Check for recent failed tasks that might need retry.
   */
  _checkFailedTasks() {
    const findings = [];
    try {
      const oneDayAgo = new Date(Date.now() - 24 * 3600000).toISOString();
      const failed = queryAll(
        `SELECT id, input, error, channel
         FROM tasks
         WHERE status = 'failed' AND created_at > $since
         ORDER BY created_at DESC LIMIT 5`,
        { $since: oneDayAgo }
      );

      if (failed.length > 0) {
        const summary = failed.map(t =>
          `Task ${t.id.slice(0, 8)}: "${(t.input || "").slice(0, 60)}..." - ${(t.error || "unknown error").slice(0, 80)}`
        ).join("\n  ");

        findings.push({
          type: "FAILED_TASKS",
          message: `${failed.length} task(s) failed in the last 24h:\n  ${summary}`,
        });
      }
    } catch {}
    return findings;
  }

  /**
   * Resolve best delivery channel - most recent channel from channel_routing.
   */
  _resolveDeliveryChannel() {
    try {
      const row = queryOne(
        `SELECT channel, meta FROM channel_routing ORDER BY updated_at DESC LIMIT 1`
      );
      if (row?.meta) {
        const meta = JSON.parse(row.meta);
        return { channel: row.channel, channelMeta: { ...meta, channel: row.channel } };
      }
    } catch {}
    return { channel: "http", channelMeta: null };
  }

  // ── User HEARTBEAT.md (backwards compatible) ─────────────────────────────

  async _userHeartbeat() {
    if (!existsSync(this.heartbeatPath)) return;

    try {
      const instructions = readFileSync(this.heartbeatPath, "utf-8").trim();
      if (!instructions) return;

      // Duplicate suppression: skip if same content within 24h
      const contentHash = this._simpleHash(instructions);
      const now = Date.now();
      if (contentHash === this._lastContentHash && (now - this._lastContentAt) < 24 * 3600000) return;
      this._lastContentHash = contentHash;
      this._lastContentAt = now;

      this.checkCount++;
      this.lastCheck = new Date().toISOString();

      console.log(`[Heartbeat] User heartbeat check #${this.checkCount}`);

      taskQueue.enqueue({
        input: `[Heartbeat check #${this.checkCount}] Follow the instructions in HEARTBEAT.md strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.\n\nInstructions from HEARTBEAT.md:\n${instructions}\n\nCurrent time: ${new Date().toISOString()}`,
        channel: "heartbeat",
        sessionId: "heartbeat",
        priority: 2,
        type: "heartbeat",
      });

      eventBus.emitEvent("heartbeat:check", { checkNumber: this.checkCount });
    } catch (err) {
      console.log(`[Heartbeat] User heartbeat error: ${err.message}`);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _isActiveHour() {
    const now = new Date();
    let hour, minute;

    if (this.activeTimezone) {
      // Get current time in configured timezone
      try {
        const formatted = now.toLocaleTimeString("en-US", { timeZone: this.activeTimezone, hour12: false, hour: "2-digit", minute: "2-digit" });
        const [h, m] = formatted.split(":").map(Number);
        hour = h;
        minute = m;
      } catch {
        // Invalid timezone - fall back to host time
        hour = now.getHours();
        minute = now.getMinutes();
      }
    } else {
      hour = now.getHours();
      minute = now.getMinutes();
    }

    const currentMinutes = hour * 60 + minute;

    // Parse start/end (supports "8", "08:00", "22:30" formats)
    const parseTime = (val) => {
      const str = String(val);
      if (str.includes(":")) {
        const [h, m] = str.split(":").map(Number);
        return h * 60 + (m || 0);
      }
      return parseInt(str, 10) * 60;
    };

    const start = parseTime(this.activeHourStart);
    const end = parseTime(this.activeHourEnd);

    return currentMinutes >= start && currentMinutes < end;
  }

  _simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash;
  }

  stats() {
    return {
      running: this.running,
      intervalMinutes: this.intervalMinutes,
      proactiveIntervalMinutes: this.proactiveIntervalMs / 60000,
      activeHours: `${this.activeHourStart}-${this.activeHourEnd}`,
      timezone: this.activeTimezone || "host",
      lastCheck: this.lastCheck,
      lastProactiveCheck: this._lastProactiveAt ? new Date(this._lastProactiveAt).toISOString() : null,
      checkCount: this.checkCount,
    };
  }
}

const heartbeat = new Heartbeat();
export default heartbeat;
