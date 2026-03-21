import { BaseChannel } from "./BaseChannel.js";
import taskQueue from "../core/TaskQueue.js";
import eventBus from "../core/EventBus.js";
import { transcribeAudio } from "../tools/transcribeAudio.js";
import { createReadStream, writeFileSync, mkdirSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { tmpdir } from "node:os";

/**
 * Slack Channel - receives messages via Slack Bolt + Socket Mode.
 *
 * Socket Mode means NO public webhook URL needed - works on any machine.
 *
 * Setup:
 * 1. Go to https://api.slack.com/apps → Create New App → From Scratch
 * 2. Under "Socket Mode" → Enable Socket Mode → Generate App-Level Token (xapp-...)
 *    → Grant scope: connections:write → copy token as SLACK_APP_TOKEN
 * 3. Under "OAuth & Permissions" → Bot Token Scopes: add:
 *      chat:write, channels:history, groups:history, im:history, mpim:history,
 *      channels:read, groups:read, im:read, mpim:read, app_mentions:read,
 *      reactions:write, reactions:read
 *    → Install app to workspace → copy Bot User OAuth Token (xoxb-...) as SLACK_BOT_TOKEN
 * 4. Under "Event Subscriptions" → Enable Events → Subscribe to bot events:
 *      message.im, app_mention
 * 5. Set env: SLACK_BOT_TOKEN, SLACK_APP_TOKEN
 *
 * Config:
 *   botToken  - xoxb-... token
 *   appToken  - xapp-... token for Socket Mode
 *   allowlist - Optional array of Slack user IDs (Uxxxxxxxx) allowed to use the bot
 *   model     - Optional model override
 *
 * The bot responds to:
 *   - Direct messages (message.im)
 *   - @mentions in channels (app_mention)
 */
export class SlackChannel extends BaseChannel {
  constructor(config) {
    super("slack", config);
    this.app = null;
    this.botUserId = null;
  }

  async start() {
    if (!this.config.botToken || !this.config.appToken) {
      console.log(`[Channel:Slack] Skipped - need SLACK_BOT_TOKEN and SLACK_APP_TOKEN`);
      return;
    }

    const { App } = await import("@slack/bolt");

    this.app = new App({
      token: this.config.botToken,
      appToken: this.config.appToken,
      socketMode: true,
      logLevel: "error",
    });

    // Resolve bot's own user ID
    try {
      const authResult = await this.app.client.auth.test({ token: this.config.botToken });
      this.botUserId = authResult.user_id;
    } catch (_) {}

    // Handle @mentions in channels
    this.app.event("app_mention", async ({ event, say }) => {
      const text = event.text
        .replace(/<@[A-Z0-9]+>/g, "")
        .trim();

      if (!text) {
        await say({ text: "Yes? Send me a task.", thread_ts: event.ts });
        return;
      }

      await this._handleMessage({
        text,
        userId: event.user,
        channelId: event.channel,
        threadTs: event.thread_ts || event.ts,
        messageTs: event.ts,
        say,
      });
    });

    // Handle direct messages
    this.app.message(async ({ message, say }) => {
      if (message.bot_id) return; // Ignore bot messages

      const hasFiles = message.files && message.files.length > 0;
      if (!message.text && !hasFiles) return;

      await this._handleMessage({
        text: message.text?.trim() || "",
        files: message.files || [],
        userId: message.user,
        channelId: message.channel,
        threadTs: message.thread_ts || message.ts,
        messageTs: message.ts,
        say,
      });
    });

    // Approval replies
    eventBus.on("approval:request", async (data) => {
      if (data.channelMeta?.channel !== "slack") return;
      try {
        await this.app.client.chat.postMessage({
          token: this.config.botToken,
          channel: data.channelMeta?.channelId,
          text: data.message,
          thread_ts: data.channelMeta?.threadTs,
        });
      } catch (_) {}
    });

    try {
      await this.app.start();
      this.running = true;
      console.log(`[Channel:Slack] Started (Socket Mode)`);
      if (this.config.allowlist?.length) {
        console.log(`[Channel:Slack] Allowlist active - ${this.config.allowlist.length} authorized user(s)`);
      }
    } catch (err) {
      console.log(`[Channel:Slack] Failed to start: ${err.message}`);
    }
  }

  async _handleMessage({ text, files = [], userId, channelId, threadTs, messageTs, say }) {
    // Allowlist check
    if (!this.isAllowed(userId)) {
      console.log(`[Channel:Slack] Blocked (not in allowlist): ${userId}`);
      await say({ text: "You are not authorized to use this agent.", thread_ts: threadTs });
      return;
    }

    console.log(`[Channel:Slack] Message from ${userId}: "${text.slice(0, 80)}"${files.length ? ` + ${files.length} file(s)` : ""}`);

    // React ⏳ to show we're working
    await this._addReaction(channelId, messageTs, "hourglass_flowing_sand");

    // Build input from text + files
    const inputParts = text ? [text] : [];
    for (const file of files) {
      const localPath = await this._downloadFile(file);
      if (!localPath) continue;

      const mimeType = file.mimetype || "";
      if (mimeType.startsWith("audio/")) {
        console.log(`[Channel:Slack] Audio file - transcribing...`);
        const transcript = await transcribeAudio(localPath);
        inputParts.push(transcript.startsWith("Error:")
          ? `[Audio file: ${localPath}]\n${transcript}`
          : `[Audio transcript]: ${transcript}`);
      } else if (mimeType.startsWith("image/")) {
        inputParts.push(`[Photo received: ${localPath}]\nUser caption: ${file.title || text || "Describe and respond to this image."}`);
      } else if (mimeType.startsWith("video/")) {
        inputParts.push(`[Video received: ${localPath}]`);
      } else {
        inputParts.push(`[File received: ${localPath} (${file.name || "document"}, ${_fmtSize(file.size)})]`);
      }
    }

    const input = inputParts.join("\n");

    const task = taskQueue.enqueue({
      input,
      channel: "slack",
      channelMeta: { userId, channelId, threadTs, messageTs, userName: userId /* TODO: resolve display name via users.info API */, channel: "slack", tenantId: this.getTenantId(), instanceKey: this.getInstanceKey() },
      sessionId: this.getSessionId(userId),
      model: this.getModel(),
    });

    try {
      const completedTask = await taskQueue.waitForCompletion(task.id);

      // Absorbed into a concurrent session - response already sent via original task
      if (this.isTaskMerged(completedTask)) {
        await this._removeReaction(channelId, messageTs, "hourglass_flowing_sand");
        await this._addReaction(channelId, messageTs, "white_check_mark");
        return;
      }

      const failed = completedTask.status === "failed";
      const response = failed
        ? `Sorry, I encountered an error: ${completedTask.error}`
        : completedTask.result || "Done.";

      // Swap ⏳ for ✅ or ❌
      await this._removeReaction(channelId, messageTs, "hourglass_flowing_sand");
      await this._addReaction(channelId, messageTs, failed ? "x" : "white_check_mark");

      // Reply in thread to keep conversations clean
      const chunks = splitMessage(response, 3800);
      for (const chunk of chunks) {
        await say({ text: chunk, thread_ts: threadTs });
      }
    } catch (error) {
      console.error(`[Channel:Slack] Error:`, error.message);
      await this._removeReaction(channelId, messageTs, "hourglass_flowing_sand");
      await this._addReaction(channelId, messageTs, "x");
      await say({ text: "Sorry, something went wrong. Please try again.", thread_ts: threadTs });
    }
  }

  async stop() {
    if (this.app) {
      await this.app.stop().catch(() => {});
      this.running = false;
      console.log(`[Channel:Slack] Stopped`);
    }
  }

  async sendReply(channelMeta, text) {
    if (!this.app) return;
    const chunks = splitMessage(text, 3800);
    for (const chunk of chunks) {
      await this.app.client.chat.postMessage({
        token: this.config.botToken,
        channel: channelMeta.channelId,
        text: chunk,
        thread_ts: channelMeta.threadTs,
      }).catch((err) => console.log(`[Channel:Slack] sendReply error: ${err.message}`));
    }
  }

  /**
   * Add an emoji reaction to a Slack message.
   * @param {string} channelId
   * @param {string} timestamp  - message ts
   * @param {string} name       - reaction name without colons (e.g. "white_check_mark")
   */
  async sendReaction(channelMeta, emoji) {
    // Map unicode emoji to Slack reaction names
    const emojiMap = { "✅": "white_check_mark", "❌": "x", "⏳": "hourglass_flowing_sand" };
    const name = emojiMap[emoji] || emoji;
    await this._addReaction(channelMeta.channelId, channelMeta.messageTs, name);
  }

  async _addReaction(channelId, timestamp, name) {
    try {
      await this.app.client.reactions.add({
        token: this.config.botToken,
        channel: channelId,
        timestamp,
        name,
      });
    } catch (_) {}
  }

  async _removeReaction(channelId, timestamp, name) {
    try {
      await this.app.client.reactions.remove({
        token: this.config.botToken,
        channel: channelId,
        timestamp,
        name,
      });
    } catch (_) {}
  }

  /**
   * Send a local file to a Slack channel.
   */
  async sendFile(channelMeta, filePath, caption) {
    if (!this.app) return;
    try {
      await this.app.client.filesUploadV2({
        token: this.config.botToken,
        channel_id: channelMeta.channelId,
        file: createReadStream(filePath),
        filename: basename(filePath),
        initial_comment: caption || undefined,
      });
    } catch (err) {
      console.log(`[Channel:Slack] sendFile error: ${err.message}`);
    }
  }

  /**
   * Download a Slack file to /tmp (requires bot token for auth).
   */
  async _downloadFile(file) {
    try {
      const url = file.url_private || file.url_private_download;
      if (!url) return null;

      const ext = extname(file.name || file.title || "").split("?")[0] || "";
      const tmpDir = join(tmpdir(), "daemora-slack");
      mkdirSync(tmpDir, { recursive: true });
      const filePath = join(tmpDir, `${file.id}${ext}`);

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.config.botToken}` },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;

      const buffer = await res.arrayBuffer();
      writeFileSync(filePath, Buffer.from(buffer));
      return filePath;
    } catch (err) {
      console.log(`[Channel:Slack] File download error: ${err.message}`);
      return null;
    }
  }
}

function _fmtSize(bytes) {
  if (!bytes) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
