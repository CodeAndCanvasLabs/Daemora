/**
 * LineChannel — LINE Messaging API.
 *
 * Transport: webhook for inbound, push API for outbound. Reply tokens
 * are single-use and expire fast — async replies must use push.
 * Signature: X-Line-Signature = HMAC-SHA256(rawBody, channelSecret) b64.
 *
 * Streaming strategy: final-only. LINE has no message-edit API; each
 * push creates a new message, and per-user daily push quotas apply.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { createLogger } from "../util/logger.js";
import {
  BaseChannel,
  type ChannelMeta,
  type IncomingMessage,
  type WebhookRequest,
  type WebhookResponse,
} from "./BaseChannel.js";
import { splitMessage } from "./StreamingEditor.js";

const log = createLogger("channel.line");

const LINE_API = "https://api.line.me/v2/bot";
const LINE_MAX_CHARS = 4990;

interface LineEvent {
  type: string;
  replyToken?: string;
  source?: { userId?: string; groupId?: string; roomId?: string };
  message?: { id: string; type: string; text?: string };
  timestamp?: number;
}

export interface LineChannelOpts {
  readonly accessToken: string;
  readonly channelSecret: string;
  readonly onMessage: (msg: IncomingMessage) => void;
  readonly allowedUsers?: readonly string[];
}

export class LineChannel extends BaseChannel {
  readonly id = "line" as const;
  readonly name = "LINE" as const;
  override readonly maxMessageLength = LINE_MAX_CHARS;

  private readonly accessToken: string;
  private readonly channelSecret: string;
  private readonly onMessage: (msg: IncomingMessage) => void;
  private readonly allowedUsers: ReadonlySet<string>;

  constructor(opts: LineChannelOpts) {
    super();
    this.accessToken = opts.accessToken;
    this.channelSecret = opts.channelSecret;
    this.onMessage = opts.onMessage;
    this.allowedUsers = new Set(opts.allowedUsers ?? []);
  }

  async start(): Promise<void> {
    log.info("line channel ready (webhook)");
  }

  async stop(): Promise<void> {}

  override webhookPath(): string {
    return "line";
  }

  override async handleWebhook(
    req: WebhookRequest,
    res: WebhookResponse,
    rawBody: string | null,
  ): Promise<void> {
    const sig = (req.headers["x-line-signature"] as string) ?? "";
    if (!rawBody || !this.verify(rawBody, sig)) {
      log.warn("line webhook: signature mismatch");
      res.status(403).end();
      return;
    }

    const body = (req.body ?? {}) as { events?: LineEvent[] };
    const events = body.events ?? [];
    res.status(200).end();

    for (const ev of events) {
      if (ev.type !== "message" || ev.message?.type !== "text") continue;
      const userId = ev.source?.userId ?? "";
      if (!userId || !this.isAllowed(userId)) continue;
      const text = (ev.message.text ?? "").trim();
      if (!text) continue;

      const incoming: IncomingMessage = {
        channel: this.id,
        userId,
        text,
        meta: {
          channel: this.id,
          userId,
          chatId: userId,
          messageId: ev.message.id,
          replyToken: ev.replyToken ?? "",
        },
        timestamp: ev.timestamp ?? Date.now(),
      };
      this.onMessage(incoming);
    }
  }

  override isAllowed(userId: string): boolean {
    if (this.allowedUsers.size === 0) return true;
    return this.allowedUsers.has(userId);
  }

  override async sendReply(meta: ChannelMeta, text: string): Promise<void> {
    const to = (meta["userId"] as string) || (meta.chatId as string);
    if (!to) return;

    const chunks = splitMessage(text, LINE_MAX_CHARS);
    for (let i = 0; i < chunks.length; i += 5) {
      const batch = chunks.slice(i, i + 5).map((t) => ({ type: "text", text: t }));
      const resp = await fetch(`${LINE_API}/message/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify({ to, messages: batch }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        log.error({ status: resp.status, body }, "line push failed");
        return;
      }
    }
  }

  private verify(rawBody: string, signature: string): boolean {
    if (!signature) return false;
    const expected = createHmac("sha256", this.channelSecret)
      .update(rawBody)
      .digest("base64");
    try {
      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}
