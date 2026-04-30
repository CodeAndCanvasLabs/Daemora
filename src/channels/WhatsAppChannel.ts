/**
 * WhatsAppChannel — receives via Twilio WhatsApp webhook, sends via
 * Twilio Messages REST API. No Twilio SDK — raw fetch with Basic auth.
 *
 * Streaming strategy: final-only. WhatsApp Business (via Twilio) doesn't
 * expose a message-edit API, so progressive edits aren't possible.
 */

import { basename } from "node:path";

import { createLogger } from "../util/logger.js";
import {
  BaseChannel,
  type ChannelMeta,
  type IncomingMessage,
  type WebhookRequest,
  type WebhookResponse,
} from "./BaseChannel.js";

const log = createLogger("channel.whatsapp");

const TWILIO_API = "https://api.twilio.com/2010-04-01";
const WA_MAX_CHARS = 1600;

interface TwilioWebhookBody {
  From?: string;
  To?: string;
  Body?: string;
  MessageSid?: string;
  NumMedia?: string;
  ProfileName?: string;
  [key: string]: string | undefined;
}

export interface WhatsAppChannelOpts {
  readonly accountSid: string;
  readonly authToken: string;
  /** The "whatsapp:+14155238886" number registered with Twilio. */
  readonly from: string;
  readonly onMessage: (msg: IncomingMessage) => void;
  readonly allowedUsers?: readonly string[];
}

export class WhatsAppChannel extends BaseChannel {
  readonly id = "whatsapp" as const;
  readonly name = "WhatsApp" as const;
  override readonly maxMessageLength = WA_MAX_CHARS;
  override readonly supportsFiles = true;

  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly from: string;
  private readonly onMessage: (msg: IncomingMessage) => void;
  private readonly allowedUsers: ReadonlySet<string>;

  constructor(opts: WhatsAppChannelOpts) {
    super();
    this.accountSid = opts.accountSid;
    this.authToken = opts.authToken;
    this.from = opts.from.startsWith("whatsapp:") ? opts.from : `whatsapp:${opts.from}`;
    this.onMessage = opts.onMessage;
    this.allowedUsers = new Set(opts.allowedUsers ?? []);
  }

  async start(): Promise<void> {
    log.info({ from: this.from }, "whatsapp channel ready (webhook)");
  }

  async stop(): Promise<void> {
    // Webhook — nothing to tear down.
  }

  override webhookPath(): string {
    return "whatsapp";
  }

  override async handleWebhook(
    req: WebhookRequest,
    res: WebhookResponse,
    _rawBody: string | null,
  ): Promise<void> {
    const body = (req.body ?? {}) as TwilioWebhookBody;
    const from = body.From ?? "";
    if (!from.startsWith("whatsapp:")) {
      res.status(200).end();
      return;
    }

    const phone = from.slice("whatsapp:".length);
    if (!this.isAllowed(phone)) {
      res.status(200).end();
      return;
    }

    const text = (body.Body ?? "").trim();
    if (!text) {
      res.status(200).end();
      return;
    }

    const incoming: IncomingMessage = {
      channel: this.id,
      userId: phone,
      text,
      meta: {
        channel: this.id,
        userId: phone,
        chatId: phone,
        from,
        profileName: body.ProfileName ?? "",
        messageId: body.MessageSid ?? "",
      },
      timestamp: Date.now(),
    };
    this.onMessage(incoming);
    res.status(200).end();
  }

  override isAllowed(userId: string): boolean {
    if (this.allowedUsers.size === 0) return true;
    return this.allowedUsers.has(userId);
  }

  /**
   * Send a local file via WhatsApp. Twilio's Messages API needs a
   * publicly-reachable `MediaUrl` — it can't upload raw bytes. We derive
   * the URL from the `PUBLIC_URL` env var + a `/media/<basename>` path
   * the host is expected to serve (e.g. via the tunnel manager). If
   * `PUBLIC_URL` isn't set we fall back to sending the caption as text
   * so the agent at least gets a partial delivery instead of a silent
   * failure.
   */
  override async sendFile(meta: ChannelMeta, path: string, caption?: string): Promise<void> {
    const to = (meta["from"] as string) ?? (meta.userId ? `whatsapp:${meta.userId}` : "");
    if (!to) {
      log.warn({ meta }, "whatsapp sendFile: no destination");
      return;
    }
    const publicUrl = process.env["PUBLIC_URL"];
    if (!publicUrl) {
      log.warn("whatsapp sendFile: PUBLIC_URL not set — sending caption-only fallback");
      if (caption) await this.sendReply(meta, caption);
      return;
    }
    try {
      const mediaUrl = `${publicUrl.replace(/\/$/, "")}/media/${encodeURIComponent(basename(path))}`;
      const form = new URLSearchParams();
      form.set("From", this.from);
      form.set("To", to);
      form.append("MediaUrl", mediaUrl);
      if (caption && caption.trim().length > 0) form.set("Body", caption);

      const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
      const resp = await fetch(
        `${TWILIO_API}/Accounts/${this.accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
        },
      );
      if (!resp.ok) {
        const body = await resp.text();
        log.error({ status: resp.status, body }, "whatsapp sendFile failed");
      }
    } catch (err) {
      log.error({ err: (err as Error).message, path }, "whatsapp sendFile errored");
    }
  }

  override async sendReply(meta: ChannelMeta, text: string): Promise<void> {
    const to = (meta["from"] as string) ?? (meta.userId ? `whatsapp:${meta.userId}` : "");
    if (!to) {
      log.warn({ meta }, "whatsapp sendReply: no destination");
      return;
    }

    const form = new URLSearchParams();
    form.set("From", this.from);
    form.set("To", to);
    form.set("Body", text);

    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
    const resp = await fetch(
      `${TWILIO_API}/Accounts/${this.accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      },
    );
    if (!resp.ok) {
      const body = await resp.text();
      log.error({ status: resp.status, body }, "whatsapp send failed");
    }
  }
}
