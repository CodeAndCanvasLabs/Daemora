/**
 * MattermostChannel — receives messages via Mattermost's WebSocket API.
 *
 * Setup:
 *   1. Create a Bot Account in System Console → Integrations → Bot Accounts.
 *   2. Copy the bot access token and user id.
 *   3. Provide MATTERMOST_URL, MATTERMOST_TOKEN, MATTERMOST_BOT_USER_ID,
 *      optionally MATTERMOST_BOT_USERNAME (used to detect @mentions).
 *
 * Only responds to DMs or @mentions — otherwise the bot would reply to
 * every channel message it can see.
 */

import { createLogger } from "../util/logger.js";
import { BaseChannel, type ChannelMeta, type IncomingMessage } from "./BaseChannel.js";

const log = createLogger("channel.mattermost");

// Minimal local typing for the `ws` package (no @types/ws installed).
type WsLike = {
  on(event: "open" | "close", cb: () => void): void;
  on(event: "message", cb: (raw: Buffer | string) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  send(data: string): void;
  close(): void;
  readyState: number;
};

export interface MattermostChannelOpts {
  readonly url: string;
  readonly token: string;
  readonly botUserId: string;
  readonly botUsername?: string;
  readonly allowedUsers?: readonly string[];
  readonly onMessage: (msg: IncomingMessage) => void;
}

interface MattermostWsMessage {
  event?: string;
  data?: {
    post?: string;
    channel_type?: string;
  };
}

interface MattermostPost {
  id: string;
  user_id: string;
  channel_id: string;
  message: string;
  root_id?: string;
  create_at?: number;
}

export class MattermostChannel extends BaseChannel {
  readonly id = "mattermost" as const;
  readonly name = "Mattermost" as const;
  override readonly maxMessageLength = 16_000;

  private readonly url: string;
  private readonly token: string;
  private readonly botUserId: string;
  private readonly botUsername: string | undefined;
  private readonly allowedUsers: ReadonlySet<string>;
  private readonly onMessage: (msg: IncomingMessage) => void;

  private ws: WsLike | null = null;
  private seq = 1;
  private running = false;

  constructor(opts: MattermostChannelOpts) {
    super();
    this.url = opts.url.replace(/\/+$/, "");
    this.token = opts.token;
    this.botUserId = opts.botUserId;
    this.botUsername = opts.botUsername;
    this.allowedUsers = new Set(opts.allowedUsers ?? []);
    this.onMessage = opts.onMessage;
  }

  async start(): Promise<void> {
    const { WebSocket } = (await import("ws")) as unknown as {
      WebSocket: new (url: string) => WsLike;
    };
    const wsUrl = this.url.replace(/^http/i, "ws") + "/api/v4/websocket";
    this.ws = new WebSocket(wsUrl);
    this.running = true;

    this.ws.on("open", () => {
      this.ws?.send(JSON.stringify({
        seq: this.seq++,
        action: "authentication_challenge",
        data: { token: this.token },
      }));
      log.info("mattermost websocket connected");
    });
    this.ws.on("message", (raw) => this.handleMessage(raw.toString()));
    this.ws.on("error", (err) => log.error({ err: err.message }, "mattermost ws error"));
    this.ws.on("close", () => {
      log.info("mattermost websocket closed");
      this.running = false;
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.ws?.close();
    this.ws = null;
    log.info("mattermost channel stopped");
  }

  override async sendReply(meta: ChannelMeta, text: string): Promise<void> {
    const channelId = meta.channelId as string | undefined ?? meta.chatId;
    if (!channelId) throw new Error("Mattermost reply needs channelId in channelMeta");
    const rootId = meta.postId as string | undefined ?? meta.messageId;

    const chunks = text.match(/[\s\S]{1,4000}/g) ?? [text];
    for (const chunk of chunks) {
      const res = await fetch(`${this.url}/api/v4/posts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel_id: channelId,
          message: chunk,
          ...(rootId ? { root_id: rootId } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log.error({ status: res.status, body }, "mattermost send failed");
      }
    }
  }

  override isAllowed(userId: string): boolean {
    if (this.allowedUsers.size === 0) return true;
    return this.allowedUsers.has(userId);
  }

  private handleMessage(raw: string): void {
    let msg: MattermostWsMessage;
    try { msg = JSON.parse(raw) as MattermostWsMessage; } catch { return; }
    if (msg.event !== "posted") return;
    if (!msg.data?.post) return;

    let post: MattermostPost;
    try { post = JSON.parse(msg.data.post) as MattermostPost; } catch { return; }

    if (!post.message?.trim()) return;
    if (post.user_id === this.botUserId) return;
    if (!this.isAllowed(post.user_id)) return;

    const isDM = msg.data.channel_type === "D";
    const mentionTag = this.botUsername ? `@${this.botUsername}` : null;
    const isMentioned = !!(mentionTag && post.message.includes(mentionTag));
    if (!isDM && !isMentioned) return;

    // Strip leading mentions so the agent gets the clean prompt.
    const body = post.message.replace(/@\S+/g, "").trim() || post.message;

    const incoming: IncomingMessage = {
      channel: this.id,
      userId: post.user_id,
      text: body,
      meta: {
        channel: this.id,
        userId: post.user_id,
        channelId: post.channel_id,
        chatId: post.channel_id,
        messageId: post.id,
        postId: post.id,
        isDM,
      },
      timestamp: post.create_at ?? Date.now(),
    };
    this.onMessage(incoming);
  }
}
