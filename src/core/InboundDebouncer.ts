/**
 * InboundDebouncer — batches rapid-fire inbound messages from the same
 * session/channel into a single agent task.
 *
 * When messages arrive within the debounce window (default 1500ms),
 * they're concatenated into one task input:
 *
 *   [Queued messages]
 *   ---
 *   Message 1: first
 *   ---
 *   Message 2: second
 *
 * First caller's promise resolves with the batched text; later callers
 * get `null` — they must SKIP task creation (their message is already
 * included in the first caller's batch).
 *
 * Ported from daemora-js core/MessageQueue.js. Most valuable when
 * running channels (Telegram/Discord) where users burst-send; no-op
 * for the CLI where each message waits on the previous response.
 */

export interface DebouncerOptions {
  readonly windowMs?: number;
}

interface PendingEntry {
  readonly messages: string[];
  timer: NodeJS.Timeout;
  readonly resolvers: ((batched: string | null) => void)[];
}

const DEFAULT_WINDOW_MS = 1500;

export class InboundDebouncer {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly windowMs: number;

  constructor(opts: DebouncerOptions = {}) {
    this.windowMs = Math.max(50, opts.windowMs ?? DEFAULT_WINDOW_MS);
  }

  /**
   * Add a message to the per-session debounce queue. Returns a promise
   * that resolves with the batched text once the window closes. If this
   * caller's message is bundled into someone else's batch, resolves with
   * `null` — the caller must not create a task.
   */
  debounce(sessionKey: string, message: string): Promise<string | null> {
    return new Promise((resolve) => {
      const existing = this.pending.get(sessionKey);
      if (existing) {
        existing.messages.push(message);
        existing.resolvers.push(resolve);
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => this.flush(sessionKey), this.windowMs);
        return;
      }
      const entry: PendingEntry = {
        messages: [message],
        resolvers: [resolve],
        timer: setTimeout(() => this.flush(sessionKey), this.windowMs),
      };
      this.pending.set(sessionKey, entry);
    });
  }

  private flush(sessionKey: string): void {
    const entry = this.pending.get(sessionKey);
    if (!entry) return;
    this.pending.delete(sessionKey);

    const batched = entry.messages.length === 1
      ? entry.messages[0]!
      : `[Queued messages]\n---\n${entry.messages.map((m, i) => `Message ${i + 1}: ${m}`).join("\n---\n")}`;

    // First resolver wins; others get null so callers know not to spawn tasks.
    entry.resolvers[0]?.(batched);
    for (let i = 1; i < entry.resolvers.length; i++) {
      entry.resolvers[i]?.(null);
    }
  }

  hasPending(sessionKey: string): boolean {
    return this.pending.has(sessionKey);
  }

  get debounceMs(): number { return this.windowMs; }

  /** Cancel all pending batches (graceful shutdown). */
  shutdown(): void {
    for (const [key, entry] of this.pending) {
      clearTimeout(entry.timer);
      for (const r of entry.resolvers) r(null);
      this.pending.delete(key);
    }
  }
}
