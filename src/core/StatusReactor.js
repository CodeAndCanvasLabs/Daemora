/**
 * StatusReactor - live status feedback on channels via EventBus.
 *
 * Listens to task lifecycle events and sends:
 * - Typing indicators every 5s while processing
 * - Granular emoji reactions: 🤔 thinking → 🔧 tool use → (back to 🤔)
 *
 * Follows the Supervisor pattern: singleton, .start(), EventBus listeners.
 * Requires taskChannelMap from TaskRunner to resolve taskId → channel.
 */

import eventBus from "./EventBus.js";
import channelRegistry from "../channels/index.js";

const TYPING_INTERVAL = 5000; // 5 seconds

class StatusReactor {
  constructor() {
    this.running = false;
    // taskId → { channel, channelMeta, typingTimer, lastEmoji }
    this.activeTasks = new Map();
  }

  start() {
    if (this.running) return;
    this.running = true;

    eventBus.on("task:processing", (data) => this._onTaskStart(data));
    eventBus.on("tool:before", (data) => this._onToolStart(data));
    eventBus.on("task:completed", (data) => this._onTaskEnd(data));
    eventBus.on("task:failed", (data) => this._onTaskEnd(data));

    console.log("[StatusReactor] Started — live typing + status reactions");
  }

  stop() {
    this.running = false;
    for (const [taskId, state] of this.activeTasks) {
      if (state.typingTimer) clearInterval(state.typingTimer);
    }
    this.activeTasks.clear();
  }

  /**
   * Register a task for status tracking.
   * Called by TaskRunner when a task starts processing.
   */
  registerTask(taskId, channelName, channelMeta) {
    if (!taskId || !channelName) return;

    const channel = channelRegistry.get(channelName);
    if (!channel) return;

    const state = { channel, channelMeta, typingTimer: null, lastEmoji: null };

    // Start typing indicator loop
    state.typingTimer = setInterval(() => {
      if (!this.running) return;
      try { channel.sendTyping(channelMeta); } catch (_) {}
    }, TYPING_INTERVAL);

    // Send initial typing
    try { channel.sendTyping(channelMeta); } catch (_) {}

    this.activeTasks.set(taskId, state);
  }

  /** Unregister a task — stops typing, cleans up. */
  unregisterTask(taskId) {
    const state = this.activeTasks.get(taskId);
    if (!state) return;
    if (state.typingTimer) clearInterval(state.typingTimer);
    this.activeTasks.delete(taskId);
  }

  // ── Event Handlers ──────────────────────────────────────────────────────

  _onTaskStart(data) {
    // Task start is handled by registerTask() called from TaskRunner
  }

  _onToolStart(data) {
    // Could send tool-specific reactions here in the future
    // For now, typing indicators cover the "agent is working" signal
  }

  _onTaskEnd(data) {
    const taskId = data?.taskId;
    if (taskId) this.unregisterTask(taskId);
  }
}

const statusReactor = new StatusReactor();
export default statusReactor;
