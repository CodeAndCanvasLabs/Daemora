import { BaseChannel } from "./BaseChannel.js";
import taskQueue from "../core/TaskQueue.js";

/**
 * Twitch Channel - receives chat commands via Twitch IRC (TMI).
 *
 * Setup:
 * 1. Create a Twitch app at https://dev.twitch.tv/console
 * 2. Generate an OAuth token for the bot account (chat:read, chat:edit scope)
 *    Use: https://twitchapps.com/tmi/
 * 3. Set env: TWITCH_BOT_USERNAME, TWITCH_OAUTH_TOKEN, TWITCH_CHANNEL
 *
 * The bot responds to "!ask <question>" or "@botname <question>" in chat.
 *
 * Config:
 *   username   - Bot Twitch username
 *   token      - OAuth token (without "oauth:" prefix)
 *   channel    - Twitch channel to join (without #)
 *   prefix     - Command prefix, default "!ask"
 *   allowlist  - Optional array of Twitch usernames (mods, subscribers, etc.)
 *   model      - Optional model override
 */
export class TwitchChannel extends BaseChannel {
  constructor(config) {
    super("twitch", config);
    this.ws = null;
    this.channel = (config.channel || "").toLowerCase();
    this.prefix = config.prefix || "!ask";
  }

  async start() {
    if (!this.config.username || !this.config.token || !this.channel) {
      console.log("[Channel:Twitch] Skipped - missing TWITCH_BOT_USERNAME, TWITCH_OAUTH_TOKEN, or TWITCH_CHANNEL");
      return;
    }

    try {
      const { WebSocket } = await import("ws");
      this.ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");

      this.ws.on("open", () => {
        this.ws.send(`PASS oauth:${this.config.token}`);
        this.ws.send(`NICK ${this.config.username}`);
        this.ws.send(`JOIN #${this.channel}`);
        this.running = true;
        console.log(`[Channel:Twitch] Connected to #${this.channel}`);
      });

      this.ws.on("message", async (raw) => {
        const line = raw.toString().trim();

        // Keep alive
        if (line.startsWith("PING")) {
          this.ws.send("PONG :tmi.twitch.tv");
          return;
        }

        // Parse: :user!user@user.tmi.twitch.tv PRIVMSG #channel :message
        const match = line.match(/^:(\w+)!\w+@\w+\.tmi\.twitch\.tv PRIVMSG #(\w+) :(.+)$/);
        if (!match) return;

        const [, username, , message] = match;
        if (username.toLowerCase() === this.config.username.toLowerCase()) return;

        // Check for command prefix or @mention
        const mentioned = message.toLowerCase().includes(`@${this.config.username.toLowerCase()}`);
        const hasPrefix = message.toLowerCase().startsWith(this.prefix.toLowerCase());
        if (!hasPrefix && !mentioned) return;

        if (!this.isAllowed(username)) {
          this._sendChat(`@${username} Sorry, you're not on the allowlist.`);
          return;
        }

        const input = message
          .replace(new RegExp(`^${this.prefix}\\s*`, "i"), "")
          .replace(new RegExp(`@${this.config.username}\\s*`, "ig"), "")
          .trim();

        if (!input) return;

        const channelMeta = { channel: this.channel, username };

        const task = await taskQueue.enqueue({
          input,
          channel: "twitch",
          sessionId: this.getSessionId(username),
          channelMeta,
          model: this.getModel(),
        });

        const result = await taskQueue.waitForResult(task.id);
        if (!this.isTaskMerged(result)) {
          // Twitch chat max 500 chars per message
          const reply = (result.result || "(no response)").slice(0, 490);
          this._sendChat(`@${username} ${reply}`);
        }
      });

      this.ws.on("error", (err) => console.log(`[Channel:Twitch] WS error: ${err.message}`));
      this.ws.on("close", () => {
        this.running = false;
        console.log("[Channel:Twitch] Disconnected");
      });
    } catch (err) {
      console.log(`[Channel:Twitch] Failed to start: ${err.message}`);
    }
  }

  _sendChat(text) {
    if (this.ws?.readyState === 1) {
      this.ws.send(`PRIVMSG #${this.channel} :${text.slice(0, 490)}`);
    }
  }

  async stop() {
    if (this.ws) {
      this.ws.close();
      this.running = false;
    }
    console.log("[Channel:Twitch] Stopped");
  }

  async sendReply(channelMeta, text) {
    const prefix = channelMeta?.username ? `@${channelMeta.username} ` : "";
    this._sendChat(`${prefix}${text.slice(0, 490 - prefix.length)}`);
  }
}
