/**
 * DailyLog — append-only one-line audit feed consumed by MorningPulse.
 *
 * Subscribes to EventBus and appends a single human-readable line per
 * notable event into `<dataDir>/daily.log`. The file is intentionally
 * plaintext + append-only so the agent can read it with `read_file` and
 * the user can `tail -f` it. Rotates when it exceeds ~2 MB.
 *
 * This is a complement to the SQL audit/tasks tables, not a replacement
 * — it exists specifically so prompts like MorningPulse can scan a
 * single file without issuing SQL. If the process is offline, events
 * from that window simply aren't logged (by design — no ring buffer).
 */

import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import type { EventBus } from "../events/eventBus.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("daily-log");

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB — rotates to daily.log.1

export interface DailyLogDeps {
  readonly bus: EventBus;
  readonly dataDir: string;
}

export class DailyLog {
  private readonly filePath: string;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(private readonly deps: DailyLogDeps) {
    this.filePath = join(deps.dataDir, "daily.log");
  }

  start(): void {
    const bus = this.deps.bus;

    this.unsubscribers.push(
      bus.on("task:state", (ev) => {
        if (ev.status === "completed") {
          this.write(`task ${ev.taskId.slice(0, 8)} completed`);
        } else if (ev.status === "failed") {
          this.write(`task ${ev.taskId.slice(0, 8)} FAILED: ${(ev.error ?? "unknown").slice(0, 140)}`);
        }
      }),
    );

    this.unsubscribers.push(
      bus.on("compact:completed", (ev) => {
        this.write(
          `compacted session ${ev.sessionId.slice(0, 8)}→${ev.newSessionId.slice(0, 8)} ` +
            `(${ev.tokensBefore}→${ev.tokensAfter} tokens, ${ev.savingsPct}% saved)`,
        );
      }),
    );

    this.unsubscribers.push(
      bus.on("memory:written", (ev) => {
        this.write(`memory:${ev.target} ${ev.action}`);
      }),
    );

    this.unsubscribers.push(
      bus.on("skill:created", (ev) => this.write(`skill created: ${ev.skillId}`)),
    );
    this.unsubscribers.push(
      bus.on("skill:deleted", (ev) => this.write(`skill deleted: ${ev.skillId}`)),
    );

    this.unsubscribers.push(
      bus.on("loop:detected", (ev) => {
        this.write(`LOOP ${ev.pattern} in ${ev.toolName} (task ${ev.taskId.slice(0, 8)}): ${ev.message.slice(0, 100)}`);
      }),
    );

    log.info({ path: this.filePath }, "daily log started");
  }

  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }

  private write(message: string): void {
    try {
      this.rotateIfNeeded();
      const line = `${new Date().toISOString()} ${message}\n`;
      appendFileSync(this.filePath, line, "utf-8");
    } catch (e) {
      // Logging the log is ironic but useful — we should never crash a
      // task because the audit feed is misbehaving.
      log.warn({ err: (e as Error).message }, "daily log append failed");
    }
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const s = statSync(this.filePath);
      if (s.size < MAX_BYTES) return;
      renameSync(this.filePath, `${this.filePath}.1`);
    } catch {
      // If rotation fails we keep writing to the existing file — worst
      // case is the file keeps growing until disk complains, which is
      // already better than crashing.
    }
  }
}
