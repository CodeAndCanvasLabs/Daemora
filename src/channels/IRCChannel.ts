/**
 * IRCChannel — classic IRC over a raw TCP socket.
 *
 * Supports:
 *   • PRIVMSG in a joined #channel (responds to `!ask <q>` or @mentions).
 *   • Direct messages (any PRIVMSG targeting the bot's nick).
 *   • PING/PONG keep-alive so the server doesn't time out the connection.
 *   • NickServ password auth via PASS.
 *
 * Uses node:net — no external library. Server supplies one message per
 * \r\n-terminated line; we split with a readline interface and parse.
 */

import { createConnection, type Socket } from "node:net";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

import { createLogger } from "../util/logger.js";
import { BaseChannel, type ChannelMeta, type IncomingMessage } from "./BaseChannel.js";

const log = createLogger("channel.irc");

export interface IRCChannelOpts {
  readonly server: string;
  readonly port?: number;
  readonly nick: string;
  /** Channel name to join on connect, e.g. "#daemora". */
  readonly channel?: string;
  /** Optional server / NickServ PASS command payload. */
  readonly password?: string;
  /** Command prefix for in-channel asks. Defaults to "!ask". */
  readonly prefix?: string;
  readonly allowedUsers?: readonly string[];
  readonly onMessage: (msg: IncomingMessage) => void;
}

export class IRCChannel extends BaseChannel {
  readonly id = "irc" as const;
  readonly name = "IRC" as const;
  override readonly maxMessageLength = 400; // per-PRIVMSG line cap

  private readonly server: string;
  private readonly port: number;
  private readonly nick: string;
  private readonly channel: string | undefined;
  private readonly password: string | undefined;
  private readonly prefix: string;
  private readonly allowedUsers: ReadonlySet<string>;
  private readonly onMessage: (msg: IncomingMessage) => void;

  private socket: Socket | null = null;
  private rl: ReadlineInterface | null = null;
  private running = false;

  constructor(opts: IRCChannelOpts) {
    super();
    this.server = opts.server;
    this.port = opts.port ?? 6667;
    this.nick = opts.nick;
    this.channel = opts.channel;
    this.password = opts.password;
    this.prefix = (opts.prefix ?? "!ask").toLowerCase();
    this.allowedUsers = new Set(opts.allowedUsers ?? []);
    this.onMessage = opts.onMessage;
  }

  async start(): Promise<void> {
    this.socket = createConnection(this.port, this.server);
    this.rl = createInterface({ input: this.socket });
    this.running = true;

    this.socket.on("connect", () => {
      if (this.password) this.send(`PASS ${this.password}`);
      this.send(`NICK ${this.nick}`);
      this.send(`USER ${this.nick} 0 * :Daemora Agent Bot`);
      if (this.channel) {
        setTimeout(() => this.send(`JOIN ${this.channel}`), 3000);
      }
      log.info({ server: this.server, port: this.port }, "irc connected");
    });
    this.socket.on("error", (err) => log.error({ err: err.message }, "irc socket error"));
    this.socket.on("close", () => {
      this.running = false;
      log.info("irc socket closed");
    });

    this.rl.on("line", (line) => this.handleLine(line));
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.socket) {
      this.send("QUIT :Daemora shutting down");
      this.socket.destroy();
      this.socket = null;
    }
    this.rl?.close();
    this.rl = null;
    log.info("irc channel stopped");
  }

  override async sendReply(meta: ChannelMeta, text: string): Promise<void> {
    const target = (meta.target as string | undefined) ?? (meta.chatId as string | undefined);
    if (!target) throw new Error("IRC reply needs target in channelMeta");
    const lines = text.split("\n").flatMap((line) => line.match(/.{1,400}/g) ?? [line]);
    const maxLines = 20;
    for (const line of lines.slice(0, maxLines)) {
      this.send(`PRIVMSG ${target} :${line}`);
      // IRC anti-flood — small delay between lines.
      await new Promise((r) => setTimeout(r, 100));
    }
    if (lines.length > maxLines) {
      this.send(`PRIVMSG ${target} :(${lines.length - maxLines} more lines truncated)`);
    }
  }

  override isAllowed(userId: string): boolean {
    if (this.allowedUsers.size === 0) return true;
    return this.allowedUsers.has(userId);
  }

  // ── Internals ───────────────────────────────────────────────────

  private send(text: string): void {
    if (this.socket?.writable) this.socket.write(`${text}\r\n`);
  }

  private handleLine(line: string): void {
    if (line.startsWith("PING")) {
      this.send(`PONG ${line.slice(5)}`);
      return;
    }

    // :nick!user@host PRIVMSG target :message
    const match = line.match(/^:(\S+?)!(\S+)@\S+ PRIVMSG (\S+) :(.+)$/);
    if (!match) return;
    const senderNick = match[1]!;
    const target = match[3]!;
    const message = match[4]!;
    if (senderNick.toLowerCase() === this.nick.toLowerCase()) return;

    const isDM = target.toLowerCase() === this.nick.toLowerCase();
    const lowerMsg = message.toLowerCase();
    const hasPrefix = lowerMsg.startsWith(this.prefix);
    const mentioned = lowerMsg.includes(this.nick.toLowerCase());
    if (!isDM && !hasPrefix && !mentioned) return;
    if (!this.isAllowed(senderNick)) return;

    const input = isDM
      ? message.trim()
      : message
          .replace(new RegExp(`^${this.prefix}\\s*`, "i"), "")
          .replace(new RegExp(`${this.nick}[:,]?\\s*`, "ig"), "")
          .trim();
    if (!input) return;

    const replyTarget = isDM ? senderNick : target;

    const incoming: IncomingMessage = {
      channel: this.id,
      userId: senderNick,
      text: input,
      meta: {
        channel: this.id,
        userId: senderNick,
        nick: senderNick,
        target: replyTarget,
        chatId: replyTarget,
        isDM,
      },
      timestamp: Date.now(),
    };
    this.onMessage(incoming);
  }
}
