import { BaseChannel } from "./BaseChannel.js";
import taskQueue from "../core/TaskQueue.js";

/**
 * Nextcloud Talk Channel - polls Nextcloud Talk for new messages.
 *
 * Setup:
 * 1. Create a bot user in Nextcloud
 * 2. Generate an app password: Profile → Security → Devices & Sessions
 * 3. Set env: NEXTCLOUD_URL, NEXTCLOUD_USER, NEXTCLOUD_PASSWORD
 *    Optional: NEXTCLOUD_ROOM_TOKEN (specific room token to monitor)
 *
 * Config:
 *   url               - Nextcloud instance URL (e.g. https://cloud.example.com)
 *   user              - Nextcloud username
 *   password          - Nextcloud app password
 *   roomToken         - Optional: specific room token to monitor (monitors all DMs if omitted)
 *   pollIntervalMs    - Polling interval in ms (default 5000)
 *   allowlist         - Optional array of Nextcloud usernames
 *   model             - Optional model override
 */
export class NextcloudChannel extends BaseChannel {
  constructor(config) {
    super("nextcloud", config);
    this.pollInterval = null;
    this.pollMs = config.pollIntervalMs || 5000;
    this.lastMessageIds = {};
  }

  get _headers() {
    const creds = Buffer.from(`${this.config.user}:${this.config.password}`).toString("base64");
    return {
      "Authorization": `Basic ${creds}`,
      "OCS-APIRequest": "true",
      "Accept": "application/json",
    };
  }

  async start() {
    if (!this.config.url || !this.config.user || !this.config.password) {
      console.log("[Channel:Nextcloud] Skipped - missing NEXTCLOUD_URL, NEXTCLOUD_USER, or NEXTCLOUD_PASSWORD");
      return;
    }

    this.running = true;
    this.pollInterval = setInterval(() => this._poll(), this.pollMs);
    console.log(`[Channel:Nextcloud] Polling ${this.config.url} every ${this.pollMs}ms`);
  }

  async _poll() {
    const fetchFn = globalThis.fetch || (await import("node-fetch")).default;
    try {
      // Get list of conversations
      const convsRes = await fetchFn(
        `${this.config.url}/ocs/v2.php/apps/spreed/api/v4/room`,
        { headers: this._headers }
      );
      const convsData = await convsRes.json();
      const rooms = convsData?.ocs?.data || [];

      for (const room of rooms) {
        const token = room.token;
        if (this.config.roomToken && token !== this.config.roomToken) continue;
        if (room.type !== 1 && room.type !== 3) continue; // 1=DM, 3=group

        const lastKnown = this.lastMessageIds[token] || 0;

        const msgsRes = await fetchFn(
          `${this.config.url}/ocs/v2.php/apps/spreed/api/v1/chat/${token}?lookIntoFuture=0&limit=10&lastKnownMessageId=${lastKnown}`,
          { headers: this._headers }
        );
        const msgsData = await msgsRes.json();
        const messages = msgsData?.ocs?.data || [];

        for (const msg of messages) {
          if (msg.actorId === this.config.user) continue;
          if (msg.messageType !== "comment") continue;
          if (msg.id <= lastKnown) continue;

          this.lastMessageIds[token] = Math.max(this.lastMessageIds[token] || 0, msg.id);

          if (!this.isAllowed(msg.actorId)) continue;

          const input = msg.message?.trim();
          if (!input) continue;

          const channelMeta = { token, actorId: msg.actorId, messageId: msg.id };
          const task = await taskQueue.enqueue({
            input,
            channel: "nextcloud",
            sessionId: this.getSessionId(msg.actorId),
            channelMeta,
            model: this.getModel(),
          });

          taskQueue.waitForResult(task.id).then(result => {
            if (!this.isTaskMerged(result)) {
              this.sendReply(channelMeta, result.result || "(no response)");
            }
          }).catch(() => {});
        }
      }
    } catch (err) {
      // Silent polling errors
    }
  }

  async stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.running = false;
    console.log("[Channel:Nextcloud] Stopped");
  }

  async sendReply(channelMeta, text) {
    if (!channelMeta?.token) return;
    const fetchFn = globalThis.fetch || (await import("node-fetch")).default;
    const chunks = text.match(/[\s\S]{1,32000}/g) || [text];
    for (const chunk of chunks) {
      const body = new URLSearchParams({ message: chunk });
      await fetchFn(
        `${this.config.url}/ocs/v2.php/apps/spreed/api/v1/chat/${channelMeta.token}`,
        {
          method: "POST",
          headers: { ...this._headers, "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        }
      );
    }
  }
}
