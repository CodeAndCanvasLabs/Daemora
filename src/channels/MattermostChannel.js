import { BaseChannel } from "./BaseChannel.js";
import taskQueue from "../core/TaskQueue.js";

/**
 * Mattermost Channel - receives messages via Mattermost WebSocket API.
 *
 * Setup:
 * 1. Create a bot account in Mattermost (System Console → Integrations → Bot Accounts)
 * 2. Copy the bot access token
 * 3. Set env: MATTERMOST_URL, MATTERMOST_TOKEN, MATTERMOST_BOT_USER_ID
 *
 * Config:
 *   url        - Mattermost server URL (e.g. https://mattermost.example.com)
 *   token      - Bot access token
 *   botUserId  - Bot user ID
 *   allowlist  - Optional array of Mattermost user IDs
 *   model      - Optional model override
 */
export class MattermostChannel extends BaseChannel {
  constructor(config) {
    super("mattermost", config);
    this.ws = null;
    this.seq = 1;
  }

  async start() {
    if (!this.config.url || !this.config.token) {
      console.log("[Channel:Mattermost] Skipped - missing MATTERMOST_URL or MATTERMOST_TOKEN");
      return;
    }

    try {
      const { WebSocket } = await import("ws");
      const wsUrl = this.config.url.replace(/^http/, "ws") + "/api/v4/websocket";

      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        // Authenticate
        this.ws.send(JSON.stringify({
          seq: this.seq++,
          action: "authentication_challenge",
          data: { token: this.config.token },
        }));
        this.running = true;
        console.log("[Channel:Mattermost] WebSocket connected");
      });

      this.ws.on("message", async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        if (msg.event !== "posted") return;
        const post = JSON.parse(msg.data?.post || "{}");
        if (!post.message?.trim()) return;
        if (post.user_id === this.config.botUserId) return;
        if (!this.isAllowed(post.user_id)) return;

        // Only respond to DMs or @mentions
        const isDM = msg.data?.channel_type === "D";
        const isMentioned = post.message.includes(`@${this.config.botUsername || "bot"}`);
        if (!isDM && !isMentioned) return;

        const input = post.message.replace(/@\S+/g, "").trim() || post.message;
        const channelMeta = { channelId: post.channel_id, userId: post.user_id, postId: post.id };

        const task = await taskQueue.enqueue({
          input,
          channel: "mattermost",
          sessionId: this.getSessionId(post.user_id),
          channelMeta,
          model: this.getModel(),
        });

        const result = await taskQueue.waitForResult(task.id);
        if (!this.isTaskMerged(result)) {
          await this.sendReply(channelMeta, result.result || "(no response)");
        }
      });

      this.ws.on("error", (err) => console.log(`[Channel:Mattermost] WS error: ${err.message}`));
      this.ws.on("close", () => {
        this.running = false;
        console.log("[Channel:Mattermost] WebSocket closed");
      });
    } catch (err) {
      console.log(`[Channel:Mattermost] Failed to start: ${err.message}`);
    }
  }

  async stop() {
    if (this.ws) {
      this.ws.close();
      this.running = false;
    }
    console.log("[Channel:Mattermost] Stopped");
  }

  async sendReply(channelMeta, text) {
    if (!this.config.url || !this.config.token || !channelMeta?.channelId) return;
    const fetchFn = globalThis.fetch || (await import("node-fetch")).default;
    // Split if needed (Mattermost limit 16383 chars per post)
    const chunks = text.match(/[\s\S]{1,4000}/g) || [text];
    for (const chunk of chunks) {
      await fetchFn(`${this.config.url}/api/v4/posts`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel_id: channelMeta.channelId,
          message: chunk,
          ...(channelMeta.postId ? { root_id: channelMeta.postId } : {}),
        }),
      });
    }
  }
}
