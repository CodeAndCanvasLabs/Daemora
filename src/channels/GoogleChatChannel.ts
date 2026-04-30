/**
 * GoogleChatChannel — Google Chat webhook bot.
 *
 * Inbound: sync webhook, respond within 30s. Async follow-ups allowed
 * via chat.googleapis.com/v1/{space}/messages.
 * Auth: service-account JWT → OAuth2 access token, cached.
 *
 * Streaming strategy: edit-in-place via PATCH once the first message
 * name is known. The webhook handler responds immediately with an
 * empty ack; all content flows through push endpoints so streaming
 * edits work the same as a normal send loop.
 *
 * Implementation note: this builds the service-account JWT manually
 * (crypto.createSign) so there's no google-auth-library dependency.
 */

import { createSign } from "node:crypto";

import { createLogger } from "../util/logger.js";
import {
  BaseChannel,
  type ChannelMeta,
  type IncomingMessage,
  type WebhookRequest,
  type WebhookResponse,
} from "./BaseChannel.js";

const log = createLogger("channel.googlechat");

const CHAT_API = "https://chat.googleapis.com/v1";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/chat.bot";

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface ChatWebhookBody {
  type?: string; // MESSAGE, ADDED_TO_SPACE, REMOVED_FROM_SPACE
  message?: {
    name?: string;
    text?: string;
    sender?: { name?: string; displayName?: string; email?: string };
    space?: { name?: string; type?: string };
    thread?: { name?: string };
  };
}

export interface GoogleChatChannelOpts {
  /** The JSON object (not string) for the service account key. */
  readonly serviceAccount: ServiceAccountKey;
  readonly onMessage: (msg: IncomingMessage) => void;
}

export class GoogleChatChannel extends BaseChannel {
  readonly id = "googlechat" as const;
  readonly name = "Google Chat" as const;
  override readonly supportsStreaming = true;
  override readonly maxMessageLength = 4000;

  private readonly key: ServiceAccountKey;
  private readonly onMessage: (msg: IncomingMessage) => void;

  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(opts: GoogleChatChannelOpts) {
    super();
    this.key = opts.serviceAccount;
    this.onMessage = opts.onMessage;
  }

  async start(): Promise<void> {
    await this.getAccessToken();
    log.info("google chat channel ready (webhook)");
  }

  async stop(): Promise<void> {}

  override webhookPath(): string {
    return "googlechat";
  }

  override async handleWebhook(
    req: WebhookRequest,
    res: WebhookResponse,
    _rawBody: string | null,
  ): Promise<void> {
    const body = (req.body ?? {}) as ChatWebhookBody;
    if (body.type !== "MESSAGE" || !body.message) {
      res.status(200).json({});
      return;
    }

    const m = body.message;
    const senderEmail = m.sender?.email ?? m.sender?.name ?? "unknown";
    const spaceName = m.space?.name ?? "";
    const threadName = m.thread?.name ?? "";
    const text = (m.text ?? "").replace(/<[^>]+>/g, "").trim();

    res.status(200).json({});

    if (!text || !spaceName) return;

    const incoming: IncomingMessage = {
      channel: this.id,
      userId: senderEmail,
      text,
      meta: {
        channel: this.id,
        userId: senderEmail,
        chatId: spaceName,
        threadId: threadName,
      },
      timestamp: Date.now(),
    };
    this.onMessage(incoming);
  }

  override async sendReply(meta: ChannelMeta, text: string): Promise<void> {
    const spaceName = (meta.chatId as string) ?? "";
    const threadName = (meta.threadId as string) ?? "";
    if (!spaceName) return;
    const token = await this.getAccessToken();
    if (!token) return;

    await fetch(`${CHAT_API}/${spaceName}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        ...(threadName ? { thread: { name: threadName } } : {}),
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
      const resp = await fetch(
        `${CHAT_API}/${prevMessageId}?updateMask=text`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text }),
        },
      );
      return resp.ok ? prevMessageId : null;
    }

    const spaceName = (meta.chatId as string) ?? "";
    const threadName = (meta.threadId as string) ?? "";
    if (!spaceName) return null;

    const resp = await fetch(`${CHAT_API}/${spaceName}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        ...(threadName ? { thread: { name: threadName } } : {}),
      }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { name?: string };
    return json.name ?? null;
  }

  // ── Access token via service-account JWT ──────────────────────

  private async getAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }
    try {
      const now = Math.floor(Date.now() / 1000);
      const claim = {
        iss: this.key.client_email,
        scope: SCOPE,
        aud: this.key.token_uri ?? OAUTH_TOKEN_URL,
        exp: now + 3600,
        iat: now,
      };
      const jwt = signJwtRS256(claim, this.key.private_key);
      const form = new URLSearchParams();
      form.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
      form.set("assertion", jwt);

      const resp = await fetch(this.key.token_uri ?? OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      if (!resp.ok) {
        log.error({ status: resp.status }, "google chat token fetch failed");
        return null;
      }
      const json = (await resp.json()) as { access_token?: string; expires_in?: number };
      if (!json.access_token) return null;
      this.accessToken = json.access_token;
      this.tokenExpiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
      return this.accessToken;
    } catch (err) {
      log.error({ err: (err as Error).message }, "google chat token error");
      return null;
    }
  }
}

function signJwtRS256(claim: Record<string, unknown>, privateKey: string): string {
  const header = { alg: "RS256", typ: "JWT" };
  const enc = (obj: unknown) => base64url(Buffer.from(JSON.stringify(obj)));
  const payload = `${enc(header)}.${enc(claim)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(payload);
  const sig = base64url(signer.sign(privateKey));
  return `${payload}.${sig}`;
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
