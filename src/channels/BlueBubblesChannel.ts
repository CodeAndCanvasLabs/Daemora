/**
 * BlueBubblesChannel — iMessage relay through a BlueBubbles server.
 *
 * BlueBubbles runs on a dedicated Mac and exposes a Socket.IO (WS)
 * event feed + REST API for iMessage. This channel:
 *   • subscribes to `new-message` events via WS
 *   • forwards inbound texts to the agent
 *   • sends replies via POST /api/v1/message/text
 *
 * Setup:
 *   1. Install BlueBubbles (https://bluebubbles.app) on a Mac.
 *   2. Configure the server, note its URL and password.
 *   3. Provide BLUEBUBBLES_URL and BLUEBUBBLES_PASSWORD.
 */

import { createLogger } from "../util/logger.js";
import { BaseChannel, type ChannelMeta, type IncomingMessage } from "./BaseChannel.js";

const log = createLogger("channel.bluebubbles");

type WsLike = {
  on(event: "open" | "close", cb: () => void): void;
  on(event: "message", cb: (raw: Buffer | string) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  close(): void;
  readyState: number;
};

export interface BlueBubblesChannelOpts {
  readonly url: string;
  readonly password: string;
  readonly allowedUsers?: readonly string[];
  readonly onMessage: (msg: IncomingMessage) => void;
}

interface BBChat {
  guid?: string;
  participants?: { id?: string }[];
}
interface BBMessage {
  guid?: string;
  text?: string;
  isFromMe?: boolean;
  handle?: { id?: string };
  chats?: BBChat[];
}

export class BlueBubblesChannel extends BaseChannel {
  readonly id = "bluebubbles" as const;
  readonly name = "BlueBubbles" as const;

  private readonly baseUrl: string;
  private readonly password: string;
  private readonly allowedUsers: ReadonlySet<string>;
  private readonly onMessage: (msg: IncomingMessage) => void;

  private ws: WsLike | null = null;

  constructor(opts: BlueBubblesChannelOpts) {
    super();
    this.baseUrl = opts.url.replace(/\/$/, "");
    this.password = opts.password;
    this.allowedUsers = new Set((opts.allowedUsers ?? []).map((a) => a.toLowerCase()));
    this.onMessage = opts.onMessage;
  }

  async start(): Promise<void> {
    const { WebSocket } = (await import("ws")) as unknown as {
      WebSocket: new (url: string) => WsLike;
    };
    const wsUrl =
      this.baseUrl.replace(/^http/i, "ws") +
      `/api/v1/socket.io/?password=${encodeURIComponent(this.password)}&transport=websocket`;

    this.ws = new WebSocket(wsUrl);

    this.ws.on("open", () => log.info({ url: this.baseUrl }, "bluebubbles connected"));
    this.ws.on("message", (raw) => this.handleMessage(raw.toString()));
    this.ws.on("error", (err) => log.error({ err: err.message }, "bluebubbles ws error"));
    this.ws.on("close", () => {
      log.info("bluebubbles disconnected");
    });
  }

  async stop(): Promise<void> {
    this.ws?.close();
    this.ws = null;
    log.info("bluebubbles channel stopped");
  }

  override async sendReply(meta: ChannelMeta, text: string): Promise<void> {
    const chatGuid = meta.chatGuid as string | undefined ?? (meta.chatId as string | undefined);
    if (!chatGuid) throw new Error("BlueBubbles reply needs chatGuid in channelMeta");
    const res = await fetch(`${this.baseUrl}/api/v1/message/text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`:${this.password}`).toString("base64")}`,
      },
      body: JSON.stringify({
        chatGuid,
        message: text,
        method: "private-api",
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log.error({ status: res.status, body }, "bluebubbles send failed");
    }
  }

  override isAllowed(userId: string): boolean {
    if (this.allowedUsers.size === 0) return true;
    return this.allowedUsers.has(userId.toLowerCase());
  }

  private handleMessage(raw: string): void {
    let msg: { event?: string; data?: BBMessage };
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.event !== "new-message") return;
    const data = msg.data;
    if (!data || data.isFromMe) return;

    const sender = data.handle?.id ?? data.chats?.[0]?.participants?.[0]?.id;
    if (!sender) return;
    if (!this.isAllowed(sender)) return;
    const input = data.text?.trim();
    if (!input) return;

    const chatGuid = data.chats?.[0]?.guid;

    const incoming: IncomingMessage = {
      channel: this.id,
      userId: sender,
      text: input,
      meta: {
        channel: this.id,
        userId: sender,
        sender,
        chatGuid,
        chatId: chatGuid ?? sender,
        ...(data.guid ? { messageId: data.guid, messageGuid: data.guid } : {}),
      },
      timestamp: Date.now(),
    };
    this.onMessage(incoming);
  }
}
