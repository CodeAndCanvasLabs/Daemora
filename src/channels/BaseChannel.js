/**
 * Base channel interface.
 * All input channels (Telegram, WhatsApp, Email, Discord, Slack, LINE, Signal) extend this.
 *
 * A channel:
 * 1. Receives raw input from its platform
 * 2. Normalizes it into a Task (via taskQueue.enqueue)
 * 3. Routes the agent's reply back to the originating platform
 *
 * Built-in capabilities (all channels get these for free):
 * - Allowlist gating  - set config.allowlist = [id, id, ...] to restrict who can send tasks.
 *                       Empty / omitted = open to all (backward compatible).
 * - Per-channel model - set config.model = "openai:gpt-4.1" to override the default model
 *                       for all tasks coming from this channel.
 * - Status reactions  - sendReaction(channelMeta, emoji) is a no-op by default.
 *                       Channels that support native reactions override this.
 */
export class BaseChannel {
  constructor(name, config) {
    this.name = name;
    this.config = config || {};
    this.running = false;
  }

  /**
   * Start listening for incoming messages.
   */
  async start() {
    throw new Error(`${this.name}: start() not implemented`);
  }

  /**
   * Stop listening.
   */
  async stop() {
    throw new Error(`${this.name}: stop() not implemented`);
  }

  /**
   * Send a reply back to the user on this channel.
   * @param {object} channelMeta - Channel-specific metadata (chat_id, phone, email, etc.)
   * @param {string} text - The response text
   */
  async sendReply(channelMeta, text) {
    throw new Error(`${this.name}: sendReply() not implemented`);
  }

  /**
   * Send a native reaction/emoji on the triggering message (optional feature).
   * Channels that support reactions (Telegram, Discord, Slack) override this.
   * Others silently ignore it.
   *
   * @param {object} channelMeta - Channel-specific metadata
   * @param {string} emoji       - Emoji to react with (e.g. "✅", "❌", "⏳")
   */
  async sendReaction(channelMeta, emoji) {
    // Default no-op - channels that support reactions override this
  }

  /**
   * Send a typing indicator on this channel (optional feature).
   * Called periodically while the agent is processing.
   * @param {object} channelMeta - Channel-specific metadata
   */
  async sendTyping(channelMeta) {
    // Default no-op - channels that support typing override this
  }

  /**
   * Check whether a user is allowed to send tasks on this channel.
   *
   * If config.allowlist is empty or not set → everyone is allowed (open channel).
   * If config.allowlist has entries → only those IDs/usernames are allowed.
   *
   * @param {string|number} userId - Platform-specific user identifier
   * @returns {boolean}
   */
  isAllowed(userId) {
    const allowlist = this.config?.allowlist;
    if (!allowlist || !Array.isArray(allowlist) || allowlist.length === 0) return true;
    return allowlist.map(String).includes(String(userId));
  }

  /**
   * Get the model override for this channel (if configured).
   * Returns null if no override - TaskRunner will use the global default.
   * @returns {string|null}
   */
  getModel() {
    return this.config?.model || null;
  }

  /**
   * Map a platform user identifier to a session ID.
   * @param {string} userId - Platform-specific user identifier
   * @returns {string} Session ID
   */
  getSessionId(userId) {
    return "main";
  }

  /**
   * Returns true if this task was silently absorbed into a concurrent agent session.
   * When true, the channel should NOT send a reply - the response was already included
   * in the original task's reply (like Claude Code's follow-up injection behaviour).
   * @param {object} completedTask
   * @returns {boolean}
   */
  isTaskMerged(completedTask) {
    return completedTask?.merged === true;
  }
}
