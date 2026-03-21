import { BaseChannel } from "./BaseChannel.js";
import taskQueue from "../core/TaskQueue.js";

/**
 * Signal Channel - receives messages via signal-cli REST API.
 *
 * signal-cli is an open-source CLI tool that acts as a Signal client.
 * It must be running separately as a daemon before Daemora starts.
 *
 * Setup:
 * 1. Install signal-cli: https://github.com/AsamK/signal-cli
 * 2. Register your phone number:
 *      signal-cli -u +1234567890 register
 *      signal-cli -u +1234567890 verify CODE
 * 3. Start signal-cli as a REST daemon:
 *      signal-cli -u +1234567890 daemon --http 127.0.0.1:8080
 * 4. Set env:
 *      SIGNAL_CLI_URL=http://127.0.0.1:8080   (signal-cli REST URL)
 *      SIGNAL_PHONE_NUMBER=+1234567890         (your registered number)
 *
 * Config:
 *   cliUrl      - signal-cli REST URL
 *   phoneNumber - your registered Signal number
 *   allowlist   - Optional array of phone numbers (+1234567890) allowed to send tasks
 *   model       - Optional model override
 *
 * Daemora polls signal-cli every 2 seconds for new messages.
 * All replies are sent back through signal-cli.
 */
export class SignalChannel extends BaseChannel {
  constructor(config) {
    super("signal", config);
    this.cliUrl = config.cliUrl;
    this.phoneNumber = config.phoneNumber;
    this.pollInterval = null;
    this.processing = new Set(); // Track in-flight messages to avoid duplicates
  }

  async start() {
    if (!this.cliUrl || !this.phoneNumber) {
      console.log(`[Channel:Signal] Skipped - need SIGNAL_CLI_URL and SIGNAL_PHONE_NUMBER`);
      return;
    }

    // Test connectivity to signal-cli
    try {
      const res = await fetch(`${this.cliUrl}/v1/health`);
      if (!res.ok) throw new Error(`signal-cli returned ${res.status}`);
    } catch (err) {
      console.log(`[Channel:Signal] Cannot reach signal-cli at ${this.cliUrl}: ${err.message}`);
      console.log(`[Channel:Signal] Start signal-cli daemon: signal-cli -u ${this.phoneNumber} daemon --http 127.0.0.1:8080`);
      return;
    }

    this.running = true;
    console.log(`[Channel:Signal] Started - polling ${this.cliUrl} for ${this.phoneNumber}`);
    if (this.config.allowlist?.length) {
      console.log(`[Channel:Signal] Allowlist active - ${this.config.allowlist.length} authorized number(s)`);
    }

    // Poll for new messages every 2 seconds
    this.pollInterval = setInterval(() => this._poll(), 2000);
  }

  async _poll() {
    try {
      const res = await fetch(
        `${this.cliUrl}/v1/receive/${encodeURIComponent(this.phoneNumber)}`,
        { signal: AbortSignal.timeout(5000) }
      );

      if (!res.ok) return;

      const messages = await res.json();
      if (!Array.isArray(messages) || messages.length === 0) return;

      for (const envelope of messages) {
        await this._handleEnvelope(envelope);
      }
    } catch (_) {
      // Silent - network errors during polling are expected if signal-cli restarts
    }
  }

  async _handleEnvelope(envelope) {
    const dataMessage = envelope?.envelope?.dataMessage;
    if (!dataMessage) return;

    const text = dataMessage.message?.trim();
    const sender = envelope?.envelope?.source;
    const timestamp = dataMessage.timestamp;

    if (!text || !sender) return;

    // Deduplicate by timestamp+sender
    const key = `${sender}:${timestamp}`;
    if (this.processing.has(key)) return;
    this.processing.add(key);

    // Clean up old keys after 30 seconds
    setTimeout(() => this.processing.delete(key), 30_000);

    // Allowlist check
    if (!this.isAllowed(sender)) {
      console.log(`[Channel:Signal] Blocked (not in allowlist): ${sender}`);
      await this.sendReply({ sender }, "You are not authorized to use this agent.");
      return;
    }

    console.log(`[Channel:Signal] Message from ${sender}: "${text.slice(0, 80)}"`);

    const task = taskQueue.enqueue({
      input: text,
      channel: "signal",
      channelMeta: { sender, userName: sender, channel: "signal" },
      sessionId: this.getSessionId(sender),
      model: this.getModel(),
    });

    try {
      const completedTask = await taskQueue.waitForCompletion(task.id);
      if (this.isTaskMerged(completedTask)) return; // absorbed into concurrent session
      const response = completedTask.status === "failed"
        ? `Error: ${completedTask.error}`
        : completedTask.result || "Done.";

      await this.sendReply({ sender }, response);
    } catch (err) {
      console.error(`[Channel:Signal] Task error: ${err.message}`);
    }
  }

  async stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.running = false;
    console.log(`[Channel:Signal] Stopped`);
  }

  async sendReply(channelMeta, text) {
    if (!this.running || !channelMeta.sender) return;

    // Signal message limit is ~64KB but keep practical
    const chunks = splitMessage(text, 3000);

    for (const chunk of chunks) {
      try {
        const res = await fetch(
          `${this.cliUrl}/v2/send`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              number: this.phoneNumber,
              recipients: [channelMeta.sender],
              message: chunk,
            }),
          }
        );
        if (!res.ok) {
          const err = await res.text();
          console.log(`[Channel:Signal] Send failed: ${err}`);
        }
      } catch (err) {
        console.log(`[Channel:Signal] sendReply error: ${err.message}`);
      }
    }
  }
}

function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) { chunks.push(remaining); break; }
    let idx = remaining.lastIndexOf("\n", maxLength);
    if (idx < maxLength * 0.5) idx = remaining.lastIndexOf(" ", maxLength);
    if (idx === -1) idx = maxLength;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }
  return chunks;
}
