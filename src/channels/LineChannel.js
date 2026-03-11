import { BaseChannel } from "./BaseChannel.js";
import taskQueue from "../core/TaskQueue.js";
import crypto from "crypto";

/**
 * LINE Channel - receives messages via LINE Messaging API webhook.
 *
 * Setup:
 * 1. Go to https://developers.line.biz → Create a provider → Create a Messaging API channel
 * 2. Under "Messaging API" → Issue a channel access token (long-lived) → LINE_CHANNEL_ACCESS_TOKEN
 * 3. Under "Basic settings" → Channel secret → LINE_CHANNEL_SECRET
 * 4. Set webhook URL to: https://your-server/webhooks/line
 *    (requires a public HTTPS URL - use ngrok or deploy to a server)
 * 5. Enable "Use webhook" → Verify
 * 6. Set env: LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN
 *
 * Config:
 *   accessToken   - Channel access token
 *   channelSecret - Channel secret for HMAC signature validation
 *   allowlist     - Optional array of LINE user IDs (Uxxxxxxxx) allowed to use the bot
 *   model         - Optional model override
 *
 * The bot responds to all direct messages sent to the LINE Official Account.
 */
export class LineChannel extends BaseChannel {
  constructor(config) {
    super("line", config);
    this.accessToken = config.accessToken;
    this.channelSecret = config.channelSecret;
  }

  async start() {
    if (!this.accessToken || !this.channelSecret) {
      console.log(`[Channel:LINE] Skipped - need LINE_CHANNEL_ACCESS_TOKEN and LINE_CHANNEL_SECRET`);
      return;
    }

    this.running = true;
    console.log(`[Channel:LINE] Ready (webhook: POST /webhooks/line)`);
    if (this.config.allowlist?.length) {
      console.log(`[Channel:LINE] Allowlist active - ${this.config.allowlist.length} authorized user(s)`);
    }
  }

  async stop() {
    this.running = false;
    console.log(`[Channel:LINE] Stopped`);
  }

  /**
   * Validate LINE webhook signature.
   * LINE signs each request with HMAC-SHA256 using the channel secret.
   */
  validateSignature(rawBody, signature) {
    const expected = crypto
      .createHmac("sha256", this.channelSecret)
      .update(rawBody)
      .digest("base64");
    return signature === expected;
  }

  /**
   * Handle incoming webhook from LINE.
   * Called from Express route in index.js - passed the validated request body.
   */
  async handleWebhook(rawBody, signature, body) {
    // Signature validation - reject unsigned requests
    if (!this.validateSignature(rawBody, signature)) {
      console.log(`[Channel:LINE] Invalid signature - request rejected`);
      return { error: "Invalid signature" };
    }

    const events = body.events || [];

    for (const event of events) {
      if (event.type !== "message" || event.message?.type !== "text") continue;

      const text = event.message.text?.trim();
      const replyToken = event.replyToken;
      const userId = event.source?.userId;

      if (!text || !replyToken) continue;

      // Allowlist check
      if (!this.isAllowed(userId)) {
        console.log(`[Channel:LINE] Blocked (not in allowlist): ${userId}`);
        await this._sendPush(userId, "You are not authorized to use this agent.");
        continue;
      }

      console.log(`[Channel:LINE] Message from ${userId}: "${text.slice(0, 80)}"`);

      const task = taskQueue.enqueue({
        input: text,
        channel: "line",
        channelMeta: { userId, replyToken, channel: "line", tenantId: this.getTenantId(), instanceKey: this.getInstanceKey() },
        sessionId: this.getSessionId(userId),
        model: this.getModel(),
      });

      // LINE reply tokens expire quickly - process in background and use push message
      taskQueue.waitForCompletion(task.id).then(async (completedTask) => {
        if (this.isTaskMerged(completedTask)) return; // absorbed into concurrent session
        const response = completedTask.status === "failed"
          ? `Sorry, I encountered an error: ${completedTask.error}`
          : completedTask.result || "Done.";

        // Use push message (not reply) since reply tokens expire fast
        await this.sendReply({ userId }, response);
      }).catch((err) => {
        console.error(`[Channel:LINE] Task error: ${err.message}`);
      });
    }

    return { ok: true };
  }

  /**
   * Send a message to a LINE user via push message API.
   * Push messages work without a reply token - needed for long-running tasks.
   */
  async sendReply(channelMeta, text) {
    if (!this.accessToken || !channelMeta.userId) return;
    await this._sendPush(channelMeta.userId, text);
  }

  async _sendPush(userId, text) {
    // LINE text message limit: 5000 chars
    const chunks = splitMessage(text, 4990);
    const messages = chunks.map((chunk) => ({ type: "text", text: chunk }));

    try {
      const res = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify({
          to: userId,
          messages: messages.slice(0, 5), // LINE allows max 5 messages per push
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        console.log(`[Channel:LINE] Push message failed: ${err}`);
      }
    } catch (err) {
      console.log(`[Channel:LINE] sendReply error: ${err.message}`);
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
