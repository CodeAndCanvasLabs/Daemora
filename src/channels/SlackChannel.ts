/**
 * SlackChannel — Slack bot via Socket Mode WebSocket.
 *
 * Connects using an xapp- app-level token for Socket Mode, then
 * receives events_api payloads and dispatches message events.
 * Outbound via Slack Web API (chat.postMessage, etc.).
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — ws has no bundled types; install @types/ws for full coverage
import { WebSocket } from "ws";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

import { createLogger } from "../util/logger.js";
import { BaseChannel, type ChannelMeta, type IncomingMessage } from "./BaseChannel.js";

const log = createLogger("channel.slack");

const SLACK_API = "https://slack.com/api";

// ── Types ─────────────────────────────────────────────────────────

interface SlackSocketPayload {
  type: string;
  envelope_id?: string;
  payload?: SlackEventPayload;
  retry_attempt?: number;
  retry_reason?: string;
}

interface SlackEventPayload {
  type: string;
  event_id?: string;
  event?: SlackMessageEvent;
}

interface SlackMessageEvent {
  type: string;
  subtype?: string;
  user?: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
}

interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<{ type: string; text: string }>;
  [key: string]: unknown;
}

export interface SlackChannelOpts {
  /** Bot token (xoxb-...) for Web API calls. */
  botToken: string;
  /** App-level token (xapp-...) for Socket Mode. */
  appToken: string;
  /** Callback when an incoming message is received. */
  onMessage: (msg: IncomingMessage) => void;
  /** Optional: only respond in these channel IDs. Empty = all. */
  allowedChannels?: readonly string[];
  /** Bot user ID — auto-resolved on start if not provided. */
  botUserId?: string;
}

// ── Channel implementation ────────────────────────────────────────

export class SlackChannel extends BaseChannel {
  readonly id = "slack" as const;
  readonly name = "Slack" as const;
  override readonly supportsStreaming = true;
  override readonly supportsFiles = true;
  override readonly maxMessageLength = 3800;

  private readonly botToken: string;
  private readonly appToken: string;
  private readonly onMessage: (msg: IncomingMessage) => void;
  private readonly allowedChannels: ReadonlySet<string>;

  private ws: WebSocket | null = null;
  private botUserId: string;
  private alive = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SlackChannelOpts) {
    super();
    this.botToken = opts.botToken;
    this.appToken = opts.appToken;
    this.onMessage = opts.onMessage;
    this.allowedChannels = new Set(opts.allowedChannels ?? []);
    this.botUserId = opts.botUserId ?? "";
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  async start(): Promise<void> {
    this.alive = true;

    // Resolve bot user ID if not provided
    if (!this.botUserId) {
      await this.resolveBotUserId();
    }

    await this.connectSocketMode();
    log.info({ botUserId: this.botUserId }, "slack channel started");
  }

  async stop(): Promise<void> {
    this.alive = false;
    this.clearPing();
    if (this.ws) {
      this.ws.close(1000, "shutdown");
      this.ws = null;
    }
    log.info("slack channel stopped");
  }

  // ── Outbound ──────────────────────────────────────────────────

  override async sendReply(meta: ChannelMeta, text: string): Promise<void> {
    const channelId = meta.chatId;
    if (!channelId) {
      log.warn({ meta }, "slack sendReply: no chatId in meta");
      return;
    }

    await this.webApi("chat.postMessage", {
      channel: channelId,
      text,
      ...(meta.threadId ? { thread_ts: meta.threadId } : {}),
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
      await this.webApi("chat.update", {
        channel: channelId,
        ts: prevMessageId,
        text,
      });
      return prevMessageId;
    }
    const resp = (await this.webApi("chat.postMessage", {
      channel: channelId,
      text,
      ...(meta.threadId ? { thread_ts: meta.threadId } : {}),
    })) as { ts?: string } | null;
    return resp?.ts ?? null;
  }

  override async sendTyping(meta: ChannelMeta): Promise<void> {
    // Slack doesn't have a direct typing indicator API for bots.
    // We can indicate processing via a temporary message or just no-op.
    log.debug({ channel: meta.chatId }, "slack typing (no-op)");
  }

  override async editMessage(meta: ChannelMeta, messageId: string, text: string): Promise<void> {
    const channelId = meta.chatId;
    if (!channelId) return;

    await this.webApi("chat.update", {
      channel: channelId,
      ts: messageId,
      text,
    });
  }

  override async deleteMessage(meta: ChannelMeta, messageId: string): Promise<void> {
    const channelId = meta.chatId;
    if (!channelId) return;

    await this.webApi("chat.delete", {
      channel: channelId,
      ts: messageId,
    });
  }

  /**
   * Upload a local file to a Slack channel via the `files.uploadV2`
   * 3-step flow:
   *   1. `files.getUploadURLExternal` → returns upload_url + file_id
   *   2. POST raw bytes to upload_url
   *   3. `files.completeUploadExternal` → associates file with channel
   * The older `files.upload` is deprecated and refuses new workspaces.
   */
  override async sendFile(meta: ChannelMeta, path: string, caption?: string): Promise<void> {
    const channelId = meta.chatId;
    if (!channelId) {
      log.warn({ meta }, "slack sendFile: no chatId in meta");
      return;
    }
    try {
      const bytes = readFileSync(path);
      const name = basename(path);
      const size = statSync(path).size;

      // Step 1: reserve an upload URL
      const form = new URLSearchParams({ filename: name, length: String(size) });
      const step1Res = await fetch(`${SLACK_API}/files.getUploadURLExternal?${form.toString()}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.botToken}` },
      });
      const step1 = (await step1Res.json()) as { ok: boolean; upload_url?: string; file_id?: string; error?: string };
      if (!step1.ok || !step1.upload_url || !step1.file_id) {
        log.error({ error: step1.error }, "slack files.getUploadURLExternal failed");
        return;
      }

      // Step 2: upload the bytes
      const upForm = new FormData();
      upForm.append("file", new Blob([new Uint8Array(bytes)]), name);
      const upRes = await fetch(step1.upload_url, { method: "POST", body: upForm });
      if (!upRes.ok) {
        log.error({ status: upRes.status }, "slack upload_url POST failed");
        return;
      }

      // Step 3: finalize & attach to channel
      const completeBody: Record<string, unknown> = {
        files: [{ id: step1.file_id, title: name }],
        channel_id: channelId,
        ...(caption && caption.trim().length > 0 ? { initial_comment: caption } : {}),
        ...(meta.threadId ? { thread_ts: meta.threadId } : {}),
      };
      await this.webApi("files.completeUploadExternal", completeBody);
    } catch (err) {
      log.error({ err: (err as Error).message, path }, "slack sendFile errored");
    }
  }

  override async sendReaction(meta: ChannelMeta, emoji: string): Promise<void> {
    const channelId = meta.chatId;
    const ts = meta.messageId;
    if (!channelId || !ts) return;

    await this.webApi("reactions.add", {
      channel: channelId,
      timestamp: ts,
      name: emoji.replace(/:/g, ""),
    });
  }

  /**
   * Send a message with Slack Block Kit formatting.
   */
  async sendBlocks(meta: ChannelMeta, blocks: SlackBlock[], fallbackText: string): Promise<void> {
    const channelId = meta.chatId;
    if (!channelId) return;

    await this.webApi("chat.postMessage", {
      channel: channelId,
      text: fallbackText,
      blocks,
      ...(meta.threadId ? { thread_ts: meta.threadId } : {}),
    });
  }

  // ── Socket Mode ───────────────────────────────────────────────

  private async connectSocketMode(): Promise<void> {
    const wsUrl = await this.openSocketConnection();
    if (!wsUrl) {
      log.error("slack: failed to get socket mode URL");
      return;
    }

    this.ws = new WebSocket(wsUrl);

    this.ws.on("open", () => {
      log.debug("slack socket mode connected");
      this.startPing();
    });

    this.ws.on("message", (raw: Buffer) => {
      try {
        const payload = JSON.parse(raw.toString()) as SlackSocketPayload;
        this.handleSocketPayload(payload);
      } catch (err) {
        log.error({ err }, "slack: failed to parse socket message");
      }
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      log.warn({ code, reason: reason.toString() }, "slack socket mode closed");
      this.clearPing();
      if (this.alive) {
        setTimeout(() => {
          if (this.alive) {
            log.info("slack reconnecting socket mode");
            this.connectSocketMode().catch((err) => {
              log.error({ err }, "slack reconnect failed");
            });
          }
        }, 5000);
      }
    });

    this.ws.on("error", (err: Error) => {
      log.error({ err }, "slack socket mode error");
    });
  }

  private async openSocketConnection(): Promise<string | null> {
    try {
      const resp = await fetch(`${SLACK_API}/apps.connections.open`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.appToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });

      const json = (await resp.json()) as { ok: boolean; url?: string; error?: string };
      if (!json.ok || !json.url) {
        log.error({ error: json.error }, "slack: apps.connections.open failed");
        return null;
      }

      return json.url;
    } catch (err) {
      log.error({ err }, "slack: failed to open socket connection");
      return null;
    }
  }

  private handleSocketPayload(payload: SlackSocketPayload): void {
    // Acknowledge the envelope immediately
    if (payload.envelope_id) {
      this.acknowledge(payload.envelope_id);
    }

    if (payload.type === "events_api" && payload.payload) {
      this.handleEventsApi(payload.payload);
    } else if (payload.type === "disconnect") {
      log.info("slack: received disconnect, will reconnect");
      this.ws?.close(1000, "server disconnect");
    }
  }

  private handleEventsApi(eventPayload: SlackEventPayload): void {
    const event = eventPayload.event;
    if (!event) return;

    if (event.type === "message" && !event.subtype) {
      this.onSlackMessage(event);
    }
  }

  private onSlackMessage(event: SlackMessageEvent): void {
    // Ignore bot messages
    if (event.bot_id) return;
    if (event.user === this.botUserId) return;
    if (!event.user) return;

    // Filter by allowed channels
    if (this.allowedChannels.size > 0 && !this.allowedChannels.has(event.channel)) {
      return;
    }

    if (!event.text.trim()) return;

    const incoming: IncomingMessage = {
      channel: this.id,
      userId: event.user,
      text: event.text.trim(),
      meta: {
        channel: this.id,
        userId: event.user,
        chatId: event.channel,
        messageId: event.ts,
        ...(event.thread_ts ? { threadId: event.thread_ts } : {}),
      },
      timestamp: Math.floor(parseFloat(event.ts) * 1000),
    };

    this.onMessage(incoming);
  }

  private acknowledge(envelopeId: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ envelope_id: envelopeId }));
    }
  }

  // ── Keep-alive ping ───────────────────────────────────────────

  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30_000);
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  private async resolveBotUserId(): Promise<void> {
    try {
      const json = await this.webApi("auth.test", {});
      const data = json as { ok: boolean; user_id?: string } | null;
      if (data?.ok && data.user_id) {
        this.botUserId = data.user_id;
        log.debug({ botUserId: this.botUserId }, "slack bot user ID resolved");
      }
    } catch (err) {
      log.warn({ err }, "slack: could not resolve bot user ID");
    }
  }

  private async webApi(method: string, body: Record<string, unknown>): Promise<unknown> {
    const url = `${SLACK_API}/${method}`;
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.botToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const text = await resp.text();
        log.error({ method, status: resp.status, text }, "slack web API HTTP error");
        return null;
      }

      const json = (await resp.json()) as { ok: boolean; error?: string; [key: string]: unknown };
      if (!json.ok) {
        log.error({ method, error: json.error }, "slack web API error");
        return null;
      }

      return json;
    } catch (err) {
      log.error({ err, method }, "slack web API call failed");
      return null;
    }
  }
}
