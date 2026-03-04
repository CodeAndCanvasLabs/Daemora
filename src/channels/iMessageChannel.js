import { BaseChannel } from "./BaseChannel.js";
import taskQueue from "../core/TaskQueue.js";
import { execSync } from "node:child_process";

/**
 * iMessage Channel - send/receive iMessages on macOS via AppleScript.
 *
 * Setup:
 * 1. Must run on macOS with Messages app configured
 * 2. Grant Accessibility and Automation permissions to Terminal/Node
 * 3. Set env: IMESSAGE_POLL_INTERVAL_MS (default 5000)
 *    Optional: IMESSAGE_ALLOWLIST - comma-separated phone numbers/emails
 *
 * Note: Polling-based (reads latest unread messages periodically).
 * This is a best-effort implementation — macOS AppleScript access to iMessages
 * has limitations; consider BlueBubbles channel for more reliable access.
 *
 * Config:
 *   pollIntervalMs - How often to check for new messages (default 5000)
 *   allowlist      - Optional array of phone numbers/emails
 *   model          - Optional model override
 */
export class iMessageChannel extends BaseChannel {
  constructor(config) {
    super("imessage", config);
    this.pollInterval = null;
    this.pollMs = config.pollIntervalMs || 5000;
    this.lastChecked = new Date();
    this.processedIds = new Set();
  }

  async start() {
    if (process.platform !== "darwin") {
      console.log("[Channel:iMessage] Skipped - macOS only");
      return;
    }

    try {
      // Test that osascript can access Messages
      execSync("osascript -e 'tell application \"Messages\" to count chats'", { timeout: 5000 });
    } catch {
      console.log("[Channel:iMessage] Skipped - cannot access Messages app (check Accessibility permissions)");
      return;
    }

    this.running = true;
    console.log(`[Channel:iMessage] Started polling every ${this.pollMs}ms`);

    this.pollInterval = setInterval(() => this._poll(), this.pollMs);
  }

  async _poll() {
    try {
      const script = `
        tell application "Messages"
          set output to {}
          repeat with aChat in chats
            if (count of messages of aChat) > 0 then
              set lastMsg to last message of aChat
              set msgDate to date sent of lastMsg
              set msgId to id of lastMsg
              if msgDate > date "${this.lastChecked.toLocaleString()}" then
                if incoming of lastMsg then
                  set msgContent to content of lastMsg
                  set senderId to handle id of sender of lastMsg
                  set end of output to msgId & "|" & senderId & "|" & msgContent
                end if
              end if
            end if
          end repeat
          return output
        end tell
      `;

      let raw;
      try {
        raw = execSync(`osascript -e '${script.replace(/'/g, "\\'")}'`, {
          encoding: "utf-8", timeout: 10000
        });
      } catch { return; }

      this.lastChecked = new Date();
      if (!raw.trim()) return;

      const messages = raw.trim().split(", ");
      for (const msg of messages) {
        const [id, sender, ...contentParts] = msg.split("|");
        const content = contentParts.join("|").trim();
        if (!id || !sender || !content) continue;
        if (this.processedIds.has(id)) continue;
        this.processedIds.add(id);

        if (!this.isAllowed(sender)) continue;

        const channelMeta = { sender, chatId: sender };
        const task = await taskQueue.enqueue({
          input: content,
          channel: "imessage",
          sessionId: this.getSessionId(sender),
          channelMeta,
          model: this.getModel(),
        });

        taskQueue.waitForResult(task.id).then(result => {
          if (!this.isTaskMerged(result)) {
            this.sendReply(channelMeta, result.result || "(no response)");
          }
        }).catch(() => {});
      }

      // Keep processedIds from growing unbounded
      if (this.processedIds.size > 1000) {
        const arr = [...this.processedIds];
        this.processedIds = new Set(arr.slice(-500));
      }
    } catch (err) {
      // Silent — polling failures are expected occasionally
    }
  }

  async stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.running = false;
    console.log("[Channel:iMessage] Stopped");
  }

  async sendReply(channelMeta, text) {
    if (!channelMeta?.sender) return;
    const sender = channelMeta.sender;
    // Split into chunks (AppleScript may time out on very long strings)
    const chunks = text.match(/[\s\S]{1,1000}/g) || [text];
    for (const chunk of chunks) {
      const script = `
        tell application "Messages"
          set targetService to 1st service whose service type = iMessage
          set targetBuddy to buddy "${sender.replace(/"/g, '\\"')}" of targetService
          send "${chunk.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" to targetBuddy
        end tell
      `;
      try {
        execSync(`osascript -e '${script.replace(/'/g, "\\'")}'`, { timeout: 10000 });
      } catch (err) {
        console.log(`[Channel:iMessage] Send error: ${err.message}`);
      }
    }
  }
}
