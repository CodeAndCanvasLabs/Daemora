import { BaseChannel } from "./BaseChannel.js";
import taskQueue from "../core/TaskQueue.js";

/**
 * Feishu / Lark Channel - receives events via Feishu Event API (webhook mode).
 *
 * Setup:
 * 1. Create a Feishu app at https://open.feishu.cn/app
 * 2. Enable "Bot" capability and add "im:message:receive_v1" event subscription
 * 3. Set the webhook URL to: https://your-domain.com/channels/feishu
 * 4. Set env: FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_VERIFICATION_TOKEN
 *
 * Config:
 *   appId             - Feishu App ID
 *   appSecret         - Feishu App Secret
 *   verificationToken - Event verification token
 *   port              - Webhook port (default 3004)
 *   allowlist         - Optional array of Feishu open_id values
 *   model             - Optional model override
 */
export class FeishuChannel extends BaseChannel {
  constructor(config) {
    super("feishu", config);
    this.server = null;
    this.accessToken = null;
    this.tokenExpiry = 0;
  }

  async start() {
    if (!this.config.appId || !this.config.appSecret) {
      console.log("[Channel:Feishu] Skipped - missing FEISHU_APP_ID or FEISHU_APP_SECRET");
      return;
    }

    const { createServer } = await import("node:http");

    this.server = createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/channels/feishu") {
        res.writeHead(404).end();
        return;
      }

      let body = "";
      req.on("data", d => body += d);
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);

          // URL verification challenge
          if (payload.type === "url_verification") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ challenge: payload.challenge }));
            return;
          }

          res.writeHead(200).end("ok");

          const event = payload.event;
          if (payload.header?.event_type !== "im.message.receive_v1") return;

          const msg = event.message;
          if (msg.message_type !== "text") return;

          const senderId = event.sender?.sender_id?.open_id;
          if (!senderId || !this.isAllowed(senderId)) return;

          const content = JSON.parse(msg.content || "{}");
          const input = content.text?.trim();
          if (!input) return;

          const channelMeta = {
            chatId: event.message.chat_id,
            senderId,
            messageId: msg.message_id,
          };

          const task = await taskQueue.enqueue({
            input,
            channel: "feishu",
            sessionId: this.getSessionId(senderId),
            channelMeta,
            model: this.getModel(),
          });

          const result = await taskQueue.waitForResult(task.id);
          if (!this.isTaskMerged(result)) {
            await this.sendReply(channelMeta, result.result || "(no response)");
          }
        } catch (err) {
          console.log(`[Channel:Feishu] Error processing event: ${err.message}`);
        }
      });
    });

    const port = this.config.port || 3004;
    await new Promise(resolve => this.server.listen(port, resolve));
    this.running = true;
    console.log(`[Channel:Feishu] Webhook listening on port ${port}/channels/feishu`);
  }

  async _getAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpiry) return this.accessToken;
    const fetchFn = globalThis.fetch || (await import("node-fetch")).default;
    const res = await fetchFn("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
    });
    const data = await res.json();
    this.accessToken = data.tenant_access_token;
    this.tokenExpiry = Date.now() + (data.expire - 60) * 1000;
    return this.accessToken;
  }

  async stop() {
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
      this.running = false;
    }
    console.log("[Channel:Feishu] Stopped");
  }

  async sendReply(channelMeta, text) {
    if (!channelMeta?.chatId) return;
    const token = await this._getAccessToken();
    const fetchFn = globalThis.fetch || (await import("node-fetch")).default;
    await fetchFn("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        receive_id: channelMeta.chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    });
  }
}
