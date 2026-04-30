/**
 * PollWatcher — periodic HTTP fetch + diff. Fires when the response
 * body changes.
 *
 * Config (stored in the watcher's `pattern` JSON blob):
 *   __url          URL to fetch (required)
 *   __intervalMs   poll cadence (default 5 min; minimum 10 s)
 *   __method       HTTP method (default "GET")
 *   __headers      optional headers object
 *   __diffField    optional JSONPath-lite into the body to isolate the
 *                  "did anything change" signal. Example: "items[0].id".
 *                  When omitted, we hash the entire body.
 *
 * Diff strategy:
 *   - Fetch → read body → if __diffField set, project it → hash
 *   - First poll always seeds state and does NOT fire (avoids a trigger
 *     storm on startup). Every subsequent differing hash fires.
 *   - HTTP 4xx/5xx does not fire. It logs + retries next interval.
 *   - Last-state is in-memory only; restart re-seeds on first poll.
 *
 * This is deliberately the minimum viable poll. RSS / websub / feed
 * diffing are out of scope — users can write a crew for specialised
 * diff logic and trigger it via a simpler poll.
 */

import { createHash } from "node:crypto";

import { createLogger } from "../util/logger.js";

const log = createLogger("poll-watcher");

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const MIN_INTERVAL_MS = 10_000;

export interface PollWatcherConfig {
  readonly url: string;
  readonly intervalMs?: number;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly diffField?: string;
}

export interface PollWatcherFireEvent {
  readonly url: string;
  readonly status: number;
  readonly body: string;
  readonly hash: string;
  readonly previousHash: string | null;
}

export type PollWatcherCallback = (ev: PollWatcherFireEvent) => void;

export class PollWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastHash: string | null = null;
  private polling = false;
  private readonly intervalMs: number;

  constructor(
    private readonly config: PollWatcherConfig,
    private readonly onFire: PollWatcherCallback,
  ) {
    const requested = config.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.intervalMs = Math.max(MIN_INTERVAL_MS, requested);
  }

  start(): void {
    if (this.timer) return;
    // First poll on a microtask so start() can return synchronously.
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref?.();
    log.info({ url: this.config.url, intervalMs: this.intervalMs }, "poll watcher started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for manual trigger + tests. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const res = await fetch(this.config.url, {
        method: this.config.method ?? "GET",
        ...(this.config.headers ? { headers: this.config.headers } : {}),
      });
      if (!res.ok) {
        log.warn({ url: this.config.url, status: res.status }, "poll returned non-2xx");
        return;
      }
      const body = await res.text();
      const hash = this.hashFor(body);
      if (this.lastHash === null) {
        // Seed state — first poll never fires, so a newly-created
        // watcher doesn't dump the current state as a "change".
        this.lastHash = hash;
        log.debug({ url: this.config.url, hash }, "poll seeded");
        return;
      }
      if (hash === this.lastHash) return;
      const previousHash = this.lastHash;
      this.lastHash = hash;
      try {
        this.onFire({ url: this.config.url, status: res.status, body, hash, previousHash });
      } catch (e) {
        log.error({ err: (e as Error).message }, "poll callback threw");
      }
    } catch (e) {
      log.warn({ url: this.config.url, err: (e as Error).message }, "poll fetch failed");
    } finally {
      this.polling = false;
    }
  }

  private hashFor(body: string): string {
    let payload: string;
    if (this.config.diffField) {
      try {
        const parsed = JSON.parse(body);
        const projected = project(parsed, this.config.diffField);
        payload = JSON.stringify(projected);
      } catch {
        // diffField was configured but body isn't JSON — fall back to full body.
        payload = body;
      }
    } else {
      payload = body;
    }
    return createHash("sha256").update(payload).digest("hex");
  }
}

/**
 * Very small JSONPath-lite: dotted keys + `[N]` array indexing.
 * Example: `items[0].id` against `{ items: [{ id: 42 }] }` → 42.
 * Anything unresolvable returns undefined.
 */
function project(obj: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const key of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
