/**
 * StreamingEditor - direct port of OpenClaw's draft-stream-loop pattern.
 *
 * Reference: agents/openclaw/src/channels/draft-stream-loop.ts
 *
 * Pure caller-driven utility — no EventBus subscription inside. The channel
 * handler buffers tokens and calls loop.update(text) with the FULL accumulated
 * snapshot each time. The loop schedules throttled flushes, coalesces in-flight
 * sends, and never overlaps API calls.
 *
 * Key behaviors (same as OpenClaw):
 *   1. update(text) replaces pendingText with the latest snapshot
 *   2. If a send is in flight, schedule a follow-up flush
 *   3. If throttle window has elapsed, flush immediately (no setTimeout latency)
 *   4. flush() loops while pendingText is non-empty, awaiting inFlight between iterations
 *   5. On send failure (returns false), restore pendingText and stop
 *   6. waitForInFlight() lets caller await any pending send before deciding next steps
 *
 * Usage from a channel handler:
 *
 *   import { createStreamingLoop } from "./StreamingEditor.js";
 *
 *   let stopped = false;
 *   let messageRef = null;
 *
 *   const loop = createStreamingLoop({
 *     throttleMs: 1200,
 *     isStopped: () => stopped,
 *     sendOrEditStreamMessage: async (text) => {
 *       try {
 *         if (!messageRef) {
 *           messageRef = await message.reply(text);
 *           if (!messageRef) return false;
 *         } else {
 *           await messageRef.edit(text);
 *         }
 *         return true;
 *       } catch {
 *         return false;
 *       }
 *     },
 *   });
 *
 *   // Subscribe to text:delta + text:end events for this task — buffer + update
 *   let buffer = "";
 *   const onDelta = (e) => {
 *     if (e.taskId !== task.id) return;
 *     buffer += e.delta || "";
 *     loop.update(buffer);
 *   };
 *   const onEnd = (e) => {
 *     if (e.taskId !== task.id) return;
 *     if (e.finalText && e.finalText.length >= buffer.length) buffer = e.finalText;
 *     loop.update(buffer);
 *   };
 *   eventBus.on("text:delta", onDelta);
 *   eventBus.on("text:end", onEnd);
 *
 *   // After task completes
 *   eventBus.removeListener("text:delta", onDelta);
 *   eventBus.removeListener("text:end", onEnd);
 *   await loop.flush();   // drain any final pending text
 *   stopped = true;
 *   loop.stop();
 *
 *   // The streamed message IS the final delivery — never send a duplicate.
 *   if (!messageRef) {
 *     await message.reply(completed.result);  // fallback when nothing was streamed
 *   }
 */

/**
 * @typedef {Object} StreamingLoopParams
 * @property {number} throttleMs
 * @property {() => boolean} isStopped
 * @property {(text: string) => Promise<boolean | void>} sendOrEditStreamMessage
 *   Returns true on success, false on failure (will restore pendingText and stop).
 *   undefined is treated as success.
 */

/**
 * @typedef {Object} StreamingLoop
 * @property {(text: string) => void} update
 * @property {() => Promise<void>} flush
 * @property {() => void} stop
 * @property {() => void} resetPending
 * @property {() => void} resetThrottleWindow
 * @property {() => Promise<void>} waitForInFlight
 */

/**
 * Direct port of OpenClaw's createDraftStreamLoop.
 * @param {StreamingLoopParams} params
 * @returns {StreamingLoop}
 */
export function createStreamingLoop(params) {
  let lastSentAt = 0;
  let pendingText = "";
  /** @type {Promise<boolean | void> | undefined} */
  let inFlightPromise;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    while (!params.isStopped()) {
      if (inFlightPromise) {
        await inFlightPromise;
        continue;
      }
      const text = pendingText;
      if (!text.trim()) {
        pendingText = "";
        return;
      }
      pendingText = "";
      const current = params.sendOrEditStreamMessage(text).finally(() => {
        if (inFlightPromise === current) {
          inFlightPromise = undefined;
        }
      });
      inFlightPromise = current;
      const sent = await current;
      if (sent === false) {
        pendingText = text;
        return;
      }
      lastSentAt = Date.now();
      if (!pendingText) {
        return;
      }
    }
  };

  const schedule = () => {
    if (timer) {
      return;
    }
    const delay = Math.max(0, params.throttleMs - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      void flush();
    }, delay);
  };

  return {
    update: (text) => {
      if (params.isStopped()) {
        return;
      }
      pendingText = text;
      if (inFlightPromise) {
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
    stop: () => {
      pendingText = "";
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    resetPending: () => {
      pendingText = "";
    },
    resetThrottleWindow: () => {
      lastSentAt = 0;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    waitForInFlight: async () => {
      if (inFlightPromise) {
        await inFlightPromise;
      }
    },
  };
}
