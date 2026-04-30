/**
 * DiscordChannel — Discord bot via raw Gateway WebSocket + REST API.
 *
 * No discord.js — connects directly to the Gateway for events and
 * uses REST for sending messages. Handles IDENTIFY, HEARTBEAT, and
 * MESSAGE_CREATE lifecycle.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — ws has no bundled types; install @types/ws for full coverage
import { WebSocket } from "ws";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import { createLogger } from "../util/logger.js";
import { BaseChannel, type ChannelMeta, type IncomingMessage, type InboundAttachment } from "./BaseChannel.js";

const log = createLogger("channel.discord");

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const REST_BASE = "https://discord.com/api/v10";

// ── Gateway opcodes ───────────────────────────────────────────────

const enum GatewayOp {
  Dispatch = 0,
  Heartbeat = 1,
  Identify = 2,
  Resume = 6,
  Reconnect = 7,
  InvalidSession = 9,
  Hello = 10,
  HeartbeatAck = 11,
}

// ── Types ─────────────────────────────────────────────────────────

interface GatewayPayload {
  op: number;
  d: unknown;
  s: number | null;
  t: string | null;
}

interface HelloData {
  heartbeat_interval: number;
}

interface DiscordAttachment {
  id: string;
  filename: string;
  size: number;
  url: string;
  proxy_url?: string;
  content_type?: string;
}

interface MessageCreateData {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: { id: string; username: string; bot?: boolean };
  content: string;
  timestamp: string;
  referenced_message?: { id: string };
  mentions?: Array<{ id: string }>;
  attachments?: DiscordAttachment[];
}

interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}

export interface DiscordChannelOpts {
  /** Bot token from Discord Developer Portal. */
  token: string;
  /** Callback when an incoming message is received. */
  onMessage: (msg: IncomingMessage) => void;
  /** Optional: only respond in these channel IDs. Empty = all. */
  allowedChannels?: readonly string[];
  /** Bot user ID — set after READY if not provided. */
  botUserId?: string;
  /** Gateway intents bitfield (default: GUILDS + GUILD_MESSAGES + MESSAGE_CONTENT). */
  intents?: number;
}

// Default intents: GUILDS (1<<0) | GUILD_MESSAGES (1<<9) | MESSAGE_CONTENT (1<<15)
const DEFAULT_INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

// ── Channel implementation ────────────────────────────────────────

export class DiscordChannel extends BaseChannel {
  readonly id = "discord" as const;
  readonly name = "Discord" as const;
  override readonly supportsStreaming = true;
  override readonly supportsFiles = true;
  override readonly maxMessageLength = 1990;

  private readonly token: string;
  private readonly onMessage: (msg: IncomingMessage) => void;
  private readonly allowedChannels: ReadonlySet<string>;
  private readonly intents: number;

  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private botUserId: string;
  private resumeUrl: string | null = null;
  private alive = false;

  constructor(opts: DiscordChannelOpts) {
    super();
    this.token = opts.token;
    this.onMessage = opts.onMessage;
    this.allowedChannels = new Set(opts.allowedChannels ?? []);
    this.botUserId = opts.botUserId ?? "";
    this.intents = opts.intents ?? DEFAULT_INTENTS;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  async start(): Promise<void> {
    this.alive = true;
    this.connect(GATEWAY_URL);
    log.info("discord channel starting");
  }

  async stop(): Promise<void> {
    this.alive = false;
    this.clearHeartbeat();
    if (this.ws) {
      this.ws.close(1000, "shutdown");
      this.ws = null;
    }
    log.info("discord channel stopped");
  }

  // ── Outbound ──────────────────────────────────────────────────

  async sendReply(meta: ChannelMeta, text: string): Promise<void> {
    const channelId = meta.chatId;
    if (!channelId) {
      log.warn({ meta }, "discord sendReply: no chatId (channel_id) in meta");
      return;
    }

    await this.restPost(`/channels/${channelId}/messages`, {
      content: text,
      ...(meta.messageId
        ? { message_reference: { message_id: meta.messageId } }
        : {}),
    });
  }

  override async sendOrEditStream(
    meta: ChannelMeta,
    text: string,
    prevMessageId: string | null,
  ): Promise<string | null> {
    const channelId = meta.chatId;
    if (!channelId) return null;

    if (prevMessageId) {
      await this.restPatch(`/channels/${channelId}/messages/${prevMessageId}`, { content: text });
      return prevMessageId;
    }
    const resp = (await this.restPost(`/channels/${channelId}/messages`, {
      content: text,
      ...(meta.messageId
        ? { message_reference: { message_id: meta.messageId } }
        : {}),
    })) as { id?: string } | null;
    return resp?.id ?? null;
  }

  override async sendTyping(meta: ChannelMeta): Promise<void> {
    const channelId = meta.chatId;
    if (!channelId) return;
    await this.restPost(`/channels/${channelId}/typing`, {});
  }

  /**
   * Upload a local file to the Discord channel. Uses multipart form data
   * with the JSON payload in `payload_json` and the file blob in
   * `files[0]` — the same shape discord.js emits under the hood.
   */
  override async sendFile(meta: ChannelMeta, path: string, caption?: string): Promise<void> {
    const channelId = meta.chatId;
    if (!channelId) {
      log.warn({ meta }, "discord sendFile: no chatId in meta");
      return;
    }
    try {
      const bytes = readFileSync(path);
      const name = basename(path);
      const mime = mimeFromPath(path);
      const form = new FormData();
      const payloadJson: Record<string, unknown> = {
        attachments: [{ id: 0, filename: name }],
      };
      if (caption && caption.trim().length > 0) payloadJson["content"] = caption;
      if (meta.messageId) {
        payloadJson["message_reference"] = { message_id: meta.messageId };
      }
      form.append("payload_json", JSON.stringify(payloadJson));
      form.append(
        "files[0]",
        new Blob([new Uint8Array(bytes)], { type: mime }),
        name,
      );

      const resp = await fetch(`${REST_BASE}/channels/${channelId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bot ${this.token}` },
        body: form,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        log.error({ status: resp.status, body: body.slice(0, 500) }, "discord sendFile failed");
      }
    } catch (err) {
      log.error({ err: (err as Error).message, path }, "discord sendFile errored");
    }
  }

  override async editMessage(meta: ChannelMeta, messageId: string, text: string): Promise<void> {
    const channelId = meta.chatId;
    if (!channelId) return;
    await this.restPatch(`/channels/${channelId}/messages/${messageId}`, {
      content: text,
    });
  }

  override async deleteMessage(meta: ChannelMeta, messageId: string): Promise<void> {
    const channelId = meta.chatId;
    if (!channelId) return;
    await this.restDelete(`/channels/${channelId}/messages/${messageId}`);
  }

  /**
   * Send a rich embed message.
   */
  async sendEmbed(meta: ChannelMeta, embed: DiscordEmbed): Promise<void> {
    const channelId = meta.chatId;
    if (!channelId) return;
    await this.restPost(`/channels/${channelId}/messages`, {
      embeds: [embed],
    });
  }

  // ── Gateway connection ────────────────────────────────────────

  private connect(url: string): void {
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      log.debug("discord gateway connected");
    });

    this.ws.on("message", (raw: Buffer) => {
      try {
        const payload = JSON.parse(raw.toString()) as GatewayPayload;
        this.handlePayload(payload);
      } catch (err) {
        log.error({ err }, "discord: failed to parse gateway message");
      }
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      log.warn({ code, reason: reason.toString() }, "discord gateway closed");
      this.clearHeartbeat();
      if (this.alive) {
        // Reconnect after a delay
        setTimeout(() => {
          if (this.alive) {
            const target = this.resumeUrl ?? GATEWAY_URL;
            log.info({ target }, "discord reconnecting");
            this.connect(target);
          }
        }, 5000);
      }
    });

    this.ws.on("error", (err: Error) => {
      log.error({ err }, "discord gateway error");
    });
  }

  private handlePayload(payload: GatewayPayload): void {
    if (payload.s !== null) this.seq = payload.s;

    switch (payload.op) {
      case GatewayOp.Hello:
        this.onHello(payload.d as HelloData);
        break;

      case GatewayOp.HeartbeatAck:
        // All good — heartbeat acknowledged
        break;

      case GatewayOp.Heartbeat:
        this.sendHeartbeat();
        break;

      case GatewayOp.Reconnect:
        log.info("discord: server requested reconnect");
        this.ws?.close(4000, "reconnect");
        break;

      case GatewayOp.InvalidSession:
        log.warn("discord: invalid session, re-identifying");
        this.sessionId = null;
        this.seq = null;
        setTimeout(() => this.sendIdentify(), 2000);
        break;

      case GatewayOp.Dispatch:
        this.onDispatch(payload.t!, payload.d);
        break;
    }
  }

  private onHello(data: HelloData): void {
    this.startHeartbeat(data.heartbeat_interval);

    if (this.sessionId && this.seq !== null) {
      this.sendResume();
    } else {
      this.sendIdentify();
    }
  }

  private sendIdentify(): void {
    this.gatewaySend(GatewayOp.Identify, {
      token: this.token,
      intents: this.intents,
      properties: {
        os: "linux",
        browser: "daemora",
        device: "daemora",
      },
    });
  }

  private sendResume(): void {
    this.gatewaySend(GatewayOp.Resume, {
      token: this.token,
      session_id: this.sessionId,
      seq: this.seq,
    });
  }

  private onDispatch(event: string, data: unknown): void {
    switch (event) {
      case "READY": {
        const ready = data as { session_id: string; resume_gateway_url: string; user: { id: string } };
        this.sessionId = ready.session_id;
        this.resumeUrl = ready.resume_gateway_url;
        this.botUserId = ready.user.id;
        log.info({ botUserId: this.botUserId }, "discord ready");
        break;
      }

      case "RESUMED":
        log.info("discord session resumed");
        break;

      case "MESSAGE_CREATE":
        void this.onMessageCreate(data as MessageCreateData);
        break;
    }
  }

  private async onMessageCreate(msg: MessageCreateData): Promise<void> {
    // Ignore messages from bots (including self)
    if (msg.author.bot) return;
    if (msg.author.id === this.botUserId) return;

    // DMs arrive without guild_id — always respond. In guilds, only
    // respond when directly @-mentioned so the bot doesn't reply to
    // every message in a busy channel.
    const isDM = !msg.guild_id;
    const isMention =
      this.botUserId.length > 0 &&
      (msg.mentions?.some((u) => u.id === this.botUserId) ?? false);
    if (!isDM && !isMention) return;

    // Filter by allowed channels
    if (this.allowedChannels.size > 0 && !this.allowedChannels.has(msg.channel_id)) {
      return;
    }

    // Strip user / role / everyone mention tokens from the text so the
    // model never sees raw `<@1480536382593175817>` markers.
    const text = msg.content.replace(/<@[!&]?\d+>/g, "").trim();

    // Download any inbound attachments the user posted (images, voice
    // notes, files). Discord CDN URLs are public-but-unguessable, so
    // plain fetch works without the bot token. Files land in the
    // process tmpdir where the AttachmentProcessor can inline them.
    const attachments: InboundAttachment[] = [];
    for (const att of msg.attachments ?? []) {
      const local = await downloadDiscordAttachment(att);
      if (!local) continue;
      const mime = att.content_type ?? "application/octet-stream";
      attachments.push({
        kind: kindFromMime(mime),
        path: local,
        mimeType: mime,
        filename: att.filename,
        size: att.size,
      });
    }

    if (!text && attachments.length === 0) return;

    const incoming: IncomingMessage = {
      channel: this.id,
      userId: msg.author.id,
      text,
      meta: {
        channel: this.id,
        userId: msg.author.id,
        chatId: msg.channel_id,
        messageId: msg.id,
        guildId: msg.guild_id,
        authorUsername: msg.author.username,
      },
      timestamp: new Date(msg.timestamp).getTime(),
      ...(attachments.length > 0 ? { attachments } : {}),
    };

    this.onMessage(incoming);
  }

  // ── Heartbeat ─────────────────────────────────────────────────

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    // Initial jitter: first heartbeat at random fraction of interval
    const jitter = Math.random() * intervalMs;
    setTimeout(() => {
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
    }, jitter);
  }

  private sendHeartbeat(): void {
    this.gatewaySend(GatewayOp.Heartbeat, this.seq);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private gatewaySend(op: number, d: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op, d }));
    }
  }

  // ── REST helpers ──────────────────────────────────────────────

  private async restPost(path: string, body: unknown): Promise<unknown> {
    return this.restCall("POST", path, body);
  }

  private async restPatch(path: string, body: unknown): Promise<unknown> {
    return this.restCall("PATCH", path, body);
  }

  private async restDelete(path: string): Promise<unknown> {
    return this.restCall("DELETE", path);
  }

  private async restCall(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const url = `${REST_BASE}${path}`;
    try {
      const resp = await fetch(url, {
        method,
        headers: {
          Authorization: `Bot ${this.token}`,
          "Content-Type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      if (!resp.ok) {
        const text = await resp.text();
        log.error({ method, path, status: resp.status, text }, "discord REST error");
        return null;
      }

      // 204 No Content (e.g. typing, delete)
      if (resp.status === 204) return null;

      return await resp.json();
    } catch (err) {
      log.error({ err, method, path }, "discord REST call failed");
      return null;
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

async function downloadDiscordAttachment(att: DiscordAttachment): Promise<string | null> {
  try {
    const ext = extname(att.filename) || extFromMime(att.content_type ?? "");
    const dir = join(tmpdir(), "daemora-discord");
    mkdirSync(dir, { recursive: true });
    const full = join(dir, `${att.id}${ext}`);
    const res = await fetch(att.url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      log.warn({ url: att.url, status: res.status }, "discord attachment fetch failed");
      return null;
    }
    writeFileSync(full, Buffer.from(await res.arrayBuffer()));
    return full;
  } catch (err) {
    log.warn({ err: (err as Error).message }, "discord attachment download errored");
    return null;
  }
}

function kindFromMime(mime: string): InboundAttachment["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (
    mime === "application/pdf" ||
    mime.includes("officedocument") ||
    mime === "application/msword" ||
    mime === "application/vnd.ms-excel"
  ) {
    return "document";
  }
  return "file";
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/mp4": ".m4a",
    "audio/webm": ".webm",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
  };
  return map[mime] ?? "";
}

function mimeFromPath(path: string): string {
  const ext = extname(path).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".pdf": "application/pdf",
  };
  return map[ext] ?? "application/octet-stream";
}

