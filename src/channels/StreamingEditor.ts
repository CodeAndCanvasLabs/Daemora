/**
 * StreamingEditor — throttled message edit loop.
 *
 * Caller buffers streaming text and calls `update(text)` with the full
 * accumulated snapshot. The loop schedules throttled flushes, coalesces
 * in-flight sends, and never overlaps API calls — so the external
 * messaging platform (Discord, Slack, Telegram) is not rate-limited.
 *
 * First send creates the message; subsequent sends edit it in place.
 * The caller's `sendOrEdit` callback owns that distinction.
 */

export interface StreamingLoopParams {
  /** Minimum ms between edits. Discord ≈1200, Slack/Telegram ≈1000. */
  readonly throttleMs: number;
  /** Return false on failure — the loop restores pendingText and stops. */
  readonly sendOrEdit: (text: string) => Promise<boolean | void>;
  /** If true, update() becomes a no-op and flush() returns immediately. */
  readonly isStopped: () => boolean;
}

export interface StreamingLoop {
  /** Replace pending snapshot with the latest accumulated text. */
  update(text: string): void;
  /** Drain any pending text. Blocks until the queue is empty or stopped. */
  flush(): Promise<void>;
  /** Cancel pending timers and clear buffer. Safe to call multiple times. */
  stop(): void;
  /** Wait for an in-flight send to finish (if any). */
  waitForInFlight(): Promise<void>;
}

export function createStreamingLoop(params: StreamingLoopParams): StreamingLoop {
  let lastSentAt = 0;
  let pendingText = "";
  let inFlight: Promise<boolean | void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    while (!params.isStopped()) {
      if (inFlight) {
        await inFlight;
        continue;
      }
      const text = pendingText;
      if (!text.trim()) {
        pendingText = "";
        return;
      }
      pendingText = "";
      const current = params.sendOrEdit(text).finally(() => {
        if (inFlight === current) inFlight = undefined;
      });
      inFlight = current;
      const sent = await current;
      if (sent === false) {
        pendingText = text;
        return;
      }
      lastSentAt = Date.now();
      if (!pendingText) return;
    }
  };

  const schedule = (): void => {
    if (timer) return;
    const delay = Math.max(0, params.throttleMs - (Date.now() - lastSentAt));
    timer = setTimeout(() => void flush(), delay);
  };

  return {
    update(text: string) {
      if (params.isStopped()) return;
      pendingText = text;
      if (inFlight) {
        schedule();
        return;
      }
      if (!timer && Date.now() - lastSentAt >= params.throttleMs) {
        void flush();
        return;
      }
      schedule();
    },
    flush,
    stop() {
      pendingText = "";
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    async waitForInFlight() {
      if (inFlight) await inFlight;
    },
  };
}

/**
 * Split a message into chunks at paragraph / line / word boundaries so
 * each chunk fits under `maxLen`. Used as a fallback when streaming is
 * unavailable or the platform enforces a hard message length cap.
 */
export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n\n", maxLen);
    if (cut < maxLen / 2) cut = remaining.lastIndexOf("\n", maxLen);
    if (cut < maxLen / 2) cut = remaining.lastIndexOf(" ", maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
