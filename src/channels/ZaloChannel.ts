/**
 * ZaloChannel — Zalo Official Account webhook bot.
 *
 * Zalo is Vietnam's dominant messaging platform. The OA API delivers
 * user messages as POST `user_send_text` events to a webhook URL you
 * register in the Zalo Developer Console.
 *
 * This channel hooks into the shared `/webhooks/zalo` route (routed
 * by the server via ChannelManager.dispatchWebhook) so it doesn't need
 * its own HTTP listener.
 *
 * Setup:
 *   1. Create an OA at https://oa.zalo.me
 *   2. Register an app and copy the App ID + App Secret.
 *   3. Obtain an OA access token.
 *   4. Provide ZALO_APP_ID, ZALO_APP_SECRET, ZALO_ACCESS_TOKEN.
 *   5. Point Zalo's webhook URL to `https://your-domain/webhooks/zalo`.
 */

import { createLogger } from "../util/logger.js";
import {
  BaseChannel,
  type ChannelMeta,
  type IncomingMessage,
  type WebhookRequest,
  type WebhookResponse,
} from "./BaseChannel.js";

const log = createLogger("channel.zalo");

export interface ZaloChannelOpts {
  readonly appId: string;
  readonly appSecret: string;
  readonly accessToken: string;
  readonly allowedUsers?: readonly string[];
  readonly onMessage: (msg: IncomingMessage) => void;
}

interface ZaloPayload {
  event_name?: string;
  sender?: { id?: string };
  message?: { text?: string };
  timestamp?: string | number;
}

export class ZaloChannel extends BaseChannel {
  readonly id = "zalo" as const;
  readonly name = "Zalo" as const;
  override readonly maxMessageLength = 2_000;

  private readonly accessToken: string;
  private readonly allowedUsers: ReadonlySet<string>;
  private readonly onMessage: (msg: IncomingMessage) => void;

  constructor(opts: ZaloChannelOpts) {
    super();
    this.accessToken = opts.accessToken;
    this.allowedUsers = new Set(opts.allowedUsers ?? []);
    this.onMessage = opts.onMessage;
    // appId / appSecret aren't used for outbound but reserved for later
    // signature verification work — keep them referenced so callers
    // document both.
    void opts.appId; void opts.appSecret;
  }

  async start(): Promise<void> {
    log.info("zalo channel ready — waiting for /webhooks/zalo requests");
  }

  async stop(): Promise<void> {
    log.info("zalo channel stopped");
  }

  override webhookPath(): string {
    return "zalo";
  }

  override async handleWebhook(req: WebhookRequest, res: WebhookResponse): Promise<void> {
    // Zalo uses GET for webhook verification (returns the challenge param).
    if (req.method === "GET") {
      const challenge = (req.query["challenge"] as string | undefined) ?? "ok";
      res.status(200).send(challenge);
      return;
    }
    if (req.method !== "POST") {
      res.status(405).end();
      return;
    }

    // Ack immediately — our processing happens on the onMessage callback.
    res.status(200).end("ok");

    const payload = req.body as ZaloPayload | undefined;
    if (!payload || payload.event_name !== "user_send_text") return;
    const senderId = payload.sender?.id;
    if (!senderId) return;
    if (!this.isAllowed(senderId)) return;
    const text = payload.message?.text?.trim();
    if (!text) return;

    const incoming: IncomingMessage = {
      channel: this.id,
      userId: senderId,
      text,
      meta: {
        channel: this.id,
        userId: senderId,
        senderId,
        chatId: senderId,
      },
      timestamp: typeof payload.timestamp === "string"
        ? Number.parseInt(payload.timestamp, 10) || Date.now()
        : payload.timestamp ?? Date.now(),
    };
    this.onMessage(incoming);
  }

  override async sendReply(meta: ChannelMeta, text: string): Promise<void> {
    const recipient = meta.senderId as string | undefined ?? meta.chatId;
    if (!recipient) throw new Error("Zalo reply needs senderId in channelMeta");
    const res = await fetch("https://openapi.zalo.me/v3.0/oa/message/cs", {
      method: "POST",
      headers: {
        access_token: this.accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { user_id: recipient },
        message: { text: text.slice(0, 2000) },
      }),
    });
    if (!res.ok) {
      log.error({ status: res.status }, "zalo send failed");
    }
  }

  override isAllowed(userId: string): boolean {
    if (this.allowedUsers.size === 0) return true;
    return this.allowedUsers.has(userId);
  }
}
