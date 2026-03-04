import { BaseChannel } from "./BaseChannel.js";
import taskQueue from "../core/TaskQueue.js";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";

/**
 * IRC Channel - connects to an IRC server and responds to direct messages and !ask commands.
 *
 * Setup:
 * 1. Set env: IRC_SERVER, IRC_PORT (default 6667), IRC_NICK, IRC_CHANNEL (optional)
 *    Optional: IRC_PASSWORD (NickServ), IRC_COMMAND_PREFIX (default "!ask")
 *
 * Config:
 *   server    - IRC server hostname (e.g. irc.libera.chat)
 *   port      - Port (default 6667, use 6697 for SSL)
 *   nick      - Bot nickname
 *   channel   - Channel to join (with #)
 *   password  - NickServ password (optional)
 *   prefix    - Command prefix (default "!ask")
 *   allowlist - Optional array of IRC nicks
 *   model     - Optional model override
 */
export class IRCChannel extends BaseChannel {
  constructor(config) {
    super("irc", config);
    this.socket = null;
    this.rl = null;
    this.nick = config.nick || "daemora-bot";
    this.server = config.server;
    this.port = config.port || 6667;
    this.ircChannel = config.channel;
    this.prefix = config.prefix || "!ask";
  }

  async start() {
    if (!this.server || !this.nick) {
      console.log("[Channel:IRC] Skipped - missing IRC_SERVER or IRC_NICK");
      return;
    }

    try {
      this.socket = createConnection(this.port, this.server);
      this.rl = createInterface({ input: this.socket });

      this.socket.on("connect", () => {
        if (this.config.password) {
          this._send(`PASS ${this.config.password}`);
        }
        this._send(`NICK ${this.nick}`);
        this._send(`USER ${this.nick} 0 * :Daemora Agent Bot`);
        if (this.ircChannel) {
          setTimeout(() => this._send(`JOIN ${this.ircChannel}`), 3000);
        }
        this.running = true;
        console.log(`[Channel:IRC] Connected to ${this.server}:${this.port}`);
      });

      this.rl.on("line", async (line) => {
        // PING/PONG keep-alive
        if (line.startsWith("PING")) {
          this._send(`PONG ${line.slice(5)}`);
          return;
        }

        // Parse PRIVMSG: :nick!user@host PRIVMSG target :message
        const match = line.match(/^:(\S+?)!(\S+)@\S+ PRIVMSG (\S+) :(.+)$/);
        if (!match) return;

        const [, senderNick, , target, message] = match;
        if (senderNick.toLowerCase() === this.nick.toLowerCase()) return;

        // Determine if it's a DM (target === our nick) or channel command
        const isDM = target.toLowerCase() === this.nick.toLowerCase();
        const hasPrefix = message.toLowerCase().startsWith(this.prefix.toLowerCase());
        const mentioned = message.toLowerCase().includes(this.nick.toLowerCase());

        if (!isDM && !hasPrefix && !mentioned) return;
        if (!this.isAllowed(senderNick)) return;

        const input = isDM
          ? message.trim()
          : message.replace(new RegExp(`^${this.prefix}\\s*`, "i"), "")
                   .replace(new RegExp(`${this.nick}[:,]?\\s*`, "ig"), "")
                   .trim();

        if (!input) return;

        const replyTarget = isDM ? senderNick : target;
        const channelMeta = { target: replyTarget, nick: senderNick };

        const task = await taskQueue.enqueue({
          input,
          channel: "irc",
          sessionId: this.getSessionId(senderNick),
          channelMeta,
          model: this.getModel(),
        });

        const result = await taskQueue.waitForResult(task.id);
        if (!this.isTaskMerged(result)) {
          await this.sendReply(channelMeta, result.result || "(no response)");
        }
      });

      this.socket.on("error", (err) => console.log(`[Channel:IRC] Error: ${err.message}`));
      this.socket.on("close", () => {
        this.running = false;
        console.log("[Channel:IRC] Disconnected");
      });
    } catch (err) {
      console.log(`[Channel:IRC] Failed to start: ${err.message}`);
    }
  }

  _send(text) {
    if (this.socket?.writable) {
      this.socket.write(`${text}\r\n`);
    }
  }

  async stop() {
    if (this.socket) {
      this._send("QUIT :Daemora shutting down");
      this.socket.destroy();
      this.running = false;
    }
    console.log("[Channel:IRC] Stopped");
  }

  async sendReply(channelMeta, text) {
    if (!channelMeta?.target) return;
    // Split long responses into multiple lines (IRC limit 512 bytes per message)
    const lines = text.split("\n").flatMap(line =>
      line.match(/.{1,400}/g) || [line]
    );
    for (const line of lines.slice(0, 20)) { // max 20 lines to avoid flood
      this._send(`PRIVMSG ${channelMeta.target} :${line}`);
      await new Promise(r => setTimeout(r, 100)); // anti-flood delay
    }
    if (lines.length > 20) {
      this._send(`PRIVMSG ${channelMeta.target} :(${lines.length - 20} more lines truncated)`);
    }
  }
}
