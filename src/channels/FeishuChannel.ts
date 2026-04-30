/**
 * FeishuChannel — Feishu / Lark webhook bot.
 *
 * Inbound: webhook, URL verification challenge handshake on first setup.
 * Outbound: POST /open-apis/im/v1/messages. Supports PATCH for edit.
 * Auth: OAuth2 tenant access token, cached until just before expiry.
 *
 * Streaming strategy: edit-in-place. Feishu lets us PATCH a message by
 * its id, so the base streaming loop works — we just need the id back
 * from the first send.
 */

import { createLogger } from "../util/logger.js";
import {
  BaseChannel,
  type ChannelMeta,
  type IncomingMessage,
  type WebhookRequest,
  type WebhookResponse,
} from "./BaseChannel.js";

const log = createLogger("channel.feishu");

const FEISHU_API = "https://open.feishu.cn/open-apis";

interface FeishuTokenResponse {
  code: number;
  tenant_access_token?: string;
  expire?: number;
  msg?: string;
}

interface FeishuEventEnvelope {
  schema?: string;
  type?: string;
  challenge?: string;
  header?: { event_type?: string };
  event?: {
    sender?: { sender_id?: { open_id?: string }; sender_type?: string };
    message?: {
      message_id: string;
      chat_id: string;
      message_type: string;
      content: string;
      create_time?: string;
    };
  };
}

export interface FeishuChannelOpts {
  readonly appId: string;
  readonly appSecret: string;
  /** Optional — only needed when Feishu sends signed encrypted events. */
  readonly verificationToken?: string;
  readonly onMessage: (msg: IncomingMessage) => void;
}

export class FeishuChannel extends BaseChannel {
  readonly id = "feishu" as const;
  readonly name = "Feishu" as const;
  override readonly supportsStreaming = true;
  override readonly maxMessageLength = 3500;

  private readonly appId: string;
  private readonly appSecret: string;
  private readonly verificationToken: string | undefined;
  private readonly onMessage: (msg: IncomingMessage) => void;

  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(opts: FeishuChannelOpts) {
    super();
    this.appId = opts.appId;
    this.appSecret = opts.appSecret;
    this.verificationToken = opts.verificationToken;
    this.onMessage = opts.onMessage;
  }

  async start(): Promise<void> {
    await this.getAccessToken();
    log.info("feishu channel ready (webhook)");
  }

  async stop(): Promise<void> {}

  override webhookPath(): string {
    return "feishu";
  }

  override async handleWebhook(
    req: WebhookRequest,
    res: WebhookResponse,
    _rawBody: string | null,
  ): Promise<void> {
    const body = (req.body ?? {}) as FeishuEventEnvelope;

    if (body.type === "url_verification" && body.challenge) {
      res.status(200).json({ challenge: body.challenge });
      return;
    }

    if (this.verificationToken) {
      const token = (body as { token?: string }).token;
      if (token && token !== this.verificationToken) {
        res.status(403).end();
        return;
      }
    }

    res.status(200).json({ code: 0 });

    const eventType = body.header?.event_type;
    if (eventType !== "im.message.receive_v1") return;
    const ev = body.event;
    const msg = ev?.message;
    if (!msg || msg.message_type !== "text") return;

    const senderId = ev?.sender?.sender_id?.open_id;
    if (!senderId) return;

    let text = "";
    try {
      const parsed = JSON.parse(msg.content) as { text?: string };
      text = (parsed.text ?? "").trim();
    } catch {
      return;
    }
    if (!text) return;

    const incoming: IncomingMessage = {
      channel: this.id,
      userId: senderId,
      text,
      meta: {
        channel: this.id,
        userId: senderId,
        chatId: msg.chat_id,
        messageId: msg.message_id,
      },
      timestamp: msg.create_time ? Number(msg.create_time) : Date.now(),
    };
    this.onMessage(incoming);
  }

  override async sendReply(meta: ChannelMeta, text: string): Promise<void> {
    const chatId = (meta.chatId as string) ?? "";
    if (!chatId) return;
    const token = await this.getAccessToken();
    if (!token) return;

    await fetch(`${FEISHU_API}/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    });
  }

  override async sendOrEditStream(
    meta: ChannelMeta,
    text: string,
    prevMessageId: string | null,
  ): Promise<string | null> {
    const token = await this.getAccessToken();
    if (!token) return null;

    if (prevMessageId) {
      await fetch(`${FEISHU_API}/im/v1/messages/${prevMessageId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: JSON.stringify({ text }) }),
      });
      return prevMessageId;
    }

    const chatId = (meta.chatId as string) ?? "";
    if (!chatId) return null;

    const resp = await fetch(
      `${FEISHU_API}/im/v1/messages?receive_id_type=chat_id`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        }),
      },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { data?: { message_id?: string } };
    return json.data?.message_id ?? null;
  }

  private async getAccessToken(): Promise<string | null> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    try {
      const resp = await fetch(
        `${FEISHU_API}/auth/v3/tenant_access_token/internal`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
        },
      );
      const json = (await resp.json()) as FeishuTokenResponse;
      if (json.code !== 0 || !json.tenant_access_token) {
        log.error({ code: json.code, msg: json.msg }, "feishu token fetch failed");
        return null;
      }
      this.token = json.tenant_access_token;
      this.tokenExpiresAt = Date.now() + (json.expire ?? 7200) * 1000;
      return this.token;
    } catch (err) {
      log.error({ err: (err as Error).message }, "feishu token fetch failed");
      return null;
    }
  }
}
