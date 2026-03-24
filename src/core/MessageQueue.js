/**
 * Inbound message debouncer - batches rapid-fire messages from the same session
 * into a single task instead of spawning separate agent loops for each.
 *
 * When messages arrive within the debounce window (default 1.5s), they're
 * concatenated into a single task input:
 *   [Queued messages]
 *   ---
 *   Message 1: first message
 *   ---
 *   Message 2: second message
 */

import { config } from "../config/default.js";

class InboundDebouncer {
  constructor() {
    // sessionId → { messages: string[], timer: NodeJS.Timeout, resolve: Function }
    this._pending = new Map();
    this._debounceMs = parseInt(process.env.DEBOUNCE_MS || "1500", 10);
  }

  /**
   * Add a message to the debounce queue for a session.
   * Returns a Promise that resolves with the batched message(s) when the debounce window closes.
   *
   * @param {string} sessionId
   * @param {string} message
   * @returns {Promise<string>} Batched message (may be single or multi)
   */
  debounce(sessionId, message) {
    return new Promise((resolve) => {
      const existing = this._pending.get(sessionId);

      if (existing) {
        // Add to existing batch, reset timer
        existing.messages.push(message);
        clearTimeout(existing.timer);
        // Only the first caller's resolve gets used; subsequent callers get null
        existing.resolvers.push(resolve);
        existing.timer = setTimeout(() => this._flush(sessionId), this._debounceMs);
      } else {
        // New batch
        const entry = {
          messages: [message],
          resolvers: [resolve],
          timer: setTimeout(() => this._flush(sessionId), this._debounceMs),
        };
        this._pending.set(sessionId, entry);
      }
    });
  }

  _flush(sessionId) {
    const entry = this._pending.get(sessionId);
    if (!entry) return;
    this._pending.delete(sessionId);

    let batched;
    if (entry.messages.length === 1) {
      batched = entry.messages[0];
    } else {
      const lines = entry.messages.map((m, i) => `Message ${i + 1}: ${m}`);
      batched = `[Queued messages]\n---\n${lines.join("\n---\n")}`;
    }

    // First resolver gets the batched message; others get null (they won't create tasks)
    entry.resolvers[0](batched);
    for (let i = 1; i < entry.resolvers.length; i++) {
      entry.resolvers[i](null);
    }
  }

  /**
   * Check if a session has pending debounced messages.
   */
  hasPending(sessionId) {
    return this._pending.has(sessionId);
  }

  /**
   * Get debounce window in ms.
   */
  get debounceMs() {
    return this._debounceMs;
  }
}

const debouncer = new InboundDebouncer();
export default debouncer;
