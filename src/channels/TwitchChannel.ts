/**
 * TwitchChannel — chat bot over Twitch's IRC gateway (wss TMI).
 *
 * Setup:
 *   1. Create a Twitch app at https://dev.twitch.tv/console
 *   2. Generate an OAuth token for the bot account (chat:read + chat:edit scopes).
 *   3. Provide TWITCH_BOT_USERNAME, TWITCH_OAUTH_TOKEN, TWITCH_CHANNEL.
 *
 * Bot listens for `!ask` / `@botname` commands in the configured
 * channel and ignores everything else so it can sit silently in busy
 * streams.
 */

import { createLogger } from "../util/logger.js";
import { BaseChannel, type ChannelMeta, type IncomingMessage } from "./BaseChannel.js";

const log = createLogger("channel.twitch");

type WsLike = {
  on(event: "open" | "close", cb: () => void): void;
  on(event: "message", cb: (raw: Buffer | string) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  send(data: string): void;
  close(): void;
  readyState: number;
};

export interface TwitchChannelOpts {
  readonly username: string;
  /** OAuth token WITHOUT the `oauth:` prefix. We add it before sending. */
  readonly token: string;
  /** Twitch channel to join, without the `#` prefix. */
  readonly channel: string;
  /** Command prefix. Default `!ask`. */
  readonly prefix?: string;
  readonly allowedUsers?: readonly string[];
  readonly onMessage: (msg: IncomingMessage) => void;
}

export class TwitchChannel extends BaseChannel {
  readonly id = "twitch" as const;
  readonly name = "Twitch" as const;
  override readonly maxMessageLength = 490; // Twitch caps PRIVMSG at 500; leave room for @mention prefix

  private readonly username: string;
  private readonly token: string;
  private readonly channel: string;
  private readonly prefix: string;
  private readonly allowedUsers: ReadonlySet<string>;
  private readonly onMessage: (msg: IncomingMessage) => void;

  private ws: WsLike | null = null;
  private running = false;

  constructor(opts: TwitchChannelOpts) {
    super();
    this.username = opts.username.toLowerCase();
    this.token = opts.token.replace(/^oauth:/i, "");
    this.channel = opts.channel.replace(/^#/, "").toLowerCase();
    this.prefix = (opts.prefix ?? "!ask").toLowerCase();
    this.allowedUsers = new Set((opts.allowedUsers ?? []).map((u) => u.toLowerCase()));
    this.onMessage = opts.onMessage;
  }

  async start(): Promise<void> {
    const { WebSocket } = (await import("ws")) as unknown as {
      WebSocket: new (url: string) => WsLike;
    };
    this.ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    this.running = true;

    this.ws.on("open", () => {
      this.ws?.send(`PASS oauth:${this.token}`);
      this.ws?.send(`NICK ${this.username}`);
      this.ws?.send(`JOIN #${this.channel}`);
      log.info({ channel: this.channel }, "twitch connected");
    });
    this.ws.on("message", (raw) => this.handleLine(raw.toString().trim()));
    this.ws.on("error", (err) => log.error({ err: err.message }, "twitch ws error"));
    this.ws.on("close", () => {
      this.running = false;
      log.info("twitch ws closed");
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.ws?.close();
    this.ws = null;
    log.info("twitch channel stopped");
  }

  override async sendReply(meta: ChannelMeta, text: string): Promise<void> {
    const mentionPrefix = meta.username ? `@${meta.username as string} ` : "";
    this.sendChat(`${mentionPrefix}${text}`);
  }

  override isAllowed(userId: string): boolean {
    if (this.allowedUsers.size === 0) return true;
    return this.allowedUsers.has(userId.toLowerCase());
  }

  // ── Internals ───────────────────────────────────────────────────

  private sendChat(text: string): void {
    if (this.ws?.readyState === 1) {
      this.ws.send(`PRIVMSG #${this.channel} :${text.slice(0, 490)}`);
    }
  }

  private handleLine(line: string): void {
    if (line.startsWith("PING")) {
      this.ws?.send("PONG :tmi.twitch.tv");
      return;
    }
    const match = line.match(/^:(\w+)!\w+@\w+\.tmi\.twitch\.tv PRIVMSG #(\w+) :(.+)$/);
    if (!match) return;
    const sender = match[1]!;
    const message = match[3]!;
    if (sender.toLowerCase() === this.username) return;

    const lower = message.toLowerCase();
    const mentioned = lower.includes(`@${this.username}`);
    const hasPrefix = lower.startsWith(this.prefix);
    if (!mentioned && !hasPrefix) return;

    if (!this.isAllowed(sender)) {
      this.sendChat(`@${sender} Sorry, you're not on the allowlist.`);
      return;
    }

    const input = message
      .replace(new RegExp(`^${this.prefix}\\s*`, "i"), "")
      .replace(new RegExp(`@${this.username}\\s*`, "ig"), "")
      .trim();
    if (!input) return;

    const incoming: IncomingMessage = {
      channel: this.id,
      userId: sender,
      text: input,
      meta: {
        channel: this.id,
        userId: sender,
        username: sender,
        chatId: this.channel,
      },
      timestamp: Date.now(),
    };
    this.onMessage(incoming);
  }
}
