import { BaseChannel } from "./BaseChannel.js";
import taskQueue from "../core/TaskQueue.js";

/**
 * Matrix Channel - receives messages via Matrix (matrix.org / Element protocol).
 *
 * Setup:
 * 1. Register a Matrix bot account (e.g. @mybot:matrix.org)
 * 2. Generate an access token via /_matrix/client/v3/login
 * 3. Set env: MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, MATRIX_BOT_USER_ID
 *
 * Config:
 *   homeserverUrl  - e.g. https://matrix.org
 *   accessToken    - Matrix access token
 *   botUserId      - e.g. @mybot:matrix.org
 *   allowlist      - Optional array of Matrix user IDs
 *   model          - Optional model override
 */
export class MatrixChannel extends BaseChannel {
  constructor(config) {
    super("matrix", config);
    this.client = null;
    this.syncToken = null;
  }

  async start() {
    if (!this.config.homeserverUrl || !this.config.accessToken) {
      console.log("[Channel:Matrix] Skipped - missing MATRIX_HOMESERVER_URL or MATRIX_ACCESS_TOKEN");
      return;
    }

    try {
      const sdk = await import("matrix-js-sdk");
      this.client = sdk.createClient({
        baseUrl: this.config.homeserverUrl,
        accessToken: this.config.accessToken,
        userId: this.config.botUserId,
      });

      this.client.on("Room.timeline", async (event, room) => {
        if (event.getType() !== "m.room.message") return;
        if (event.getSender() === this.config.botUserId) return;

        const userId = event.getSender();
        if (!this.isAllowed(userId)) return;

        const content = event.getContent();
        if (content.msgtype !== "m.text") return;

        const input = content.body?.trim();
        if (!input) return;

        const roomId = room.roomId;
        const channelMeta = { roomId, userId, eventId: event.getId() };

        const task = await taskQueue.enqueue({
          input,
          channel: "matrix",
          sessionId: this.getSessionId(userId),
          channelMeta,
          model: this.getModel(),
        });

        const result = await taskQueue.waitForResult(task.id);
        if (!this.isTaskMerged(result)) {
          await this.sendReply(channelMeta, result.result || "(no response)");
        }
      });

      await this.client.startClient({ initialSyncLimit: 0 });
      this.running = true;
      console.log(`[Channel:Matrix] Connected as ${this.config.botUserId}`);
    } catch (err) {
      console.log(`[Channel:Matrix] Failed to start: ${err.message}`);
    }
  }

  async stop() {
    if (this.client) {
      this.client.stopClient();
      this.running = false;
    }
    console.log("[Channel:Matrix] Stopped");
  }

  async sendReply(channelMeta, text) {
    if (!this.client || !channelMeta?.roomId) return;
    // Split long messages (Matrix limit ~60KB but we keep replies readable)
    const chunks = text.match(/[\s\S]{1,4000}/g) || [text];
    for (const chunk of chunks) {
      await this.client.sendMessage(channelMeta.roomId, {
        msgtype: "m.text",
        body: chunk,
      });
    }
  }
}
