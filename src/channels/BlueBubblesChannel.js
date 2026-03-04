import { BaseChannel } from "./BaseChannel.js";
import taskQueue from "../core/TaskQueue.js";

/**
 * BlueBubbles Channel - connects to a BlueBubbles server for iMessage relay.
 * BlueBubbles runs on a Mac and exposes a REST + WebSocket API for iMessages.
 *
 * Setup:
 * 1. Install BlueBubbles on a Mac: https://bluebubbles.app
 * 2. Enable the server and note the server URL + password
 * 3. Set env: BLUEBUBBLES_URL, BLUEBUBBLES_PASSWORD
 *
 * Config:
 *   url        - BlueBubbles server URL (e.g. http://192.168.1.100:1234)
 *   password   - BlueBubbles server password
 *   allowlist  - Optional array of phone numbers / email addresses
 *   model      - Optional model override
 */
export class BlueBubblesChannel extends BaseChannel {
  constructor(config) {
    super("bluebubbles", config);
    this.ws = null;
  }

  get _baseUrl() {
    return this.config.url?.replace(/\/$/, "");
  }

  async start() {
    if (!this.config.url || !this.config.password) {
      console.log("[Channel:BlueBubbles] Skipped - missing BLUEBUBBLES_URL or BLUEBUBBLES_PASSWORD");
      return;
    }

    try {
      const { WebSocket } = await import("ws");
      const wsUrl = this._baseUrl.replace(/^http/, "ws") + `/api/v1/socket.io/?password=${encodeURIComponent(this.config.password)}&transport=websocket`;

      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        this.running = true;
        console.log(`[Channel:BlueBubbles] Connected to ${this._baseUrl}`);
      });

      this.ws.on("message", async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        // BlueBubbles sends Socket.IO-style messages
        if (!msg?.event || msg.event !== "new-message") return;
        const data = msg.data;
        if (!data || data.isFromMe) return;

        const sender = data.handle?.id || data.chats?.[0]?.participants?.[0]?.id;
        if (!sender || !this.isAllowed(sender)) return;

        const input = data.text?.trim();
        if (!input) return;

        const chatGuid = data.chats?.[0]?.guid;
        const channelMeta = { chatGuid, sender, messageGuid: data.guid };

        const task = await taskQueue.enqueue({
          input,
          channel: "bluebubbles",
          sessionId: this.getSessionId(sender),
          channelMeta,
          model: this.getModel(),
        });

        const result = await taskQueue.waitForResult(task.id);
        if (!this.isTaskMerged(result)) {
          await this.sendReply(channelMeta, result.result || "(no response)");
        }
      });

      this.ws.on("error", (err) => console.log(`[Channel:BlueBubbles] WS error: ${err.message}`));
      this.ws.on("close", () => {
        this.running = false;
        console.log("[Channel:BlueBubbles] Disconnected");
      });
    } catch (err) {
      console.log(`[Channel:BlueBubbles] Failed to start: ${err.message}`);
    }
  }

  async stop() {
    if (this.ws) {
      this.ws.close();
      this.running = false;
    }
    console.log("[Channel:BlueBubbles] Stopped");
  }

  async sendReply(channelMeta, text) {
    if (!channelMeta?.chatGuid) return;
    const fetchFn = globalThis.fetch || (await import("node-fetch")).default;
    await fetchFn(`${this._baseUrl}/api/v1/message/text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${Buffer.from(`:${this.config.password}`).toString("base64")}`,
      },
      body: JSON.stringify({
        chatGuid: channelMeta.chatGuid,
        message: text,
        method: "private-api",
      }),
    });
  }
}
