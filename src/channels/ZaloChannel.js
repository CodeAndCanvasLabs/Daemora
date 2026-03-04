import { BaseChannel } from "./BaseChannel.js";
import taskQueue from "../core/TaskQueue.js";

/**
 * Zalo Channel - receives messages via Zalo Official Account API.
 * Popular messaging platform in Vietnam (~75M users).
 *
 * Setup:
 * 1. Create a Zalo Official Account at https://oa.zalo.me
 * 2. Register an app and get App ID + App Secret
 * 3. Get an access token via OAuth or ZCA token
 * 4. Set env: ZALO_APP_ID, ZALO_APP_SECRET, ZALO_ACCESS_TOKEN
 * 5. Configure webhook URL: https://your-domain.com/channels/zalo
 *
 * Config:
 *   appId       - Zalo App ID
 *   appSecret   - Zalo App Secret
 *   accessToken - Zalo OA access token
 *   port        - Webhook port (default 3005)
 *   allowlist   - Optional array of Zalo user IDs
 *   model       - Optional model override
 */
export class ZaloChannel extends BaseChannel {
  constructor(config) {
    super("zalo", config);
    this.server = null;
  }

  async start() {
    if (!this.config.appId || !this.config.accessToken) {
      console.log("[Channel:Zalo] Skipped - missing ZALO_APP_ID or ZALO_ACCESS_TOKEN");
      return;
    }

    const { createServer } = await import("node:http");

    this.server = createServer(async (req, res) => {
      if (req.url !== "/channels/zalo") {
        res.writeHead(404).end();
        return;
      }

      // Zalo sends GET for webhook verification
      if (req.method === "GET") {
        const url = new URL(req.url, `http://localhost`);
        const challenge = url.searchParams.get("challenge");
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(challenge || "ok");
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }

      let body = "";
      req.on("data", d => body += d);
      req.on("end", async () => {
        res.writeHead(200).end("ok");
        try {
          const payload = JSON.parse(body);
          if (payload.event_name !== "user_send_text") return;

          const senderId = payload.sender?.id;
          if (!senderId || !this.isAllowed(senderId)) return;

          const input = payload.message?.text?.trim();
          if (!input) return;

          const channelMeta = { senderId };
          const task = await taskQueue.enqueue({
            input,
            channel: "zalo",
            sessionId: this.getSessionId(senderId),
            channelMeta,
            model: this.getModel(),
          });

          const result = await taskQueue.waitForResult(task.id);
          if (!this.isTaskMerged(result)) {
            await this.sendReply(channelMeta, result.result || "(no response)");
          }
        } catch (err) {
          console.log(`[Channel:Zalo] Error: ${err.message}`);
        }
      });
    });

    const port = this.config.port || 3005;
    await new Promise(resolve => this.server.listen(port, resolve));
    this.running = true;
    console.log(`[Channel:Zalo] Webhook listening on port ${port}/channels/zalo`);
  }

  async stop() {
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
      this.running = false;
    }
    console.log("[Channel:Zalo] Stopped");
  }

  async sendReply(channelMeta, text) {
    if (!channelMeta?.senderId) return;
    const fetchFn = globalThis.fetch || (await import("node-fetch")).default;
    await fetchFn(`https://openapi.zalo.me/v3.0/oa/message/cs`, {
      method: "POST",
      headers: {
        "access_token": this.config.accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { user_id: channelMeta.senderId },
        message: { text: text.slice(0, 2000) },
      }),
    });
  }
}
