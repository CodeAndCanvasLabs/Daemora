/**
 * MatrixChannel — Matrix (matrix.org / Element) chat integration.
 *
 * Uses raw HTTP against the Matrix Client-Server API — no SDK — so
 * there's one less native dependency to carry. Long-polls /sync for
 * new events and sends replies via /rooms/{roomId}/send.
 *
 * Setup:
 *   1. Register a bot account, e.g. @mybot:matrix.org
 *   2. Generate an access token via /_matrix/client/v3/login
 *   3. Provide MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, and
 *      optionally MATRIX_BOT_USER_ID (used to filter out the bot's
 *      own echoes).
 */

import { createLogger } from "../util/logger.js";
import { BaseChannel, type ChannelMeta, type IncomingMessage } from "./BaseChannel.js";

const log = createLogger("channel.matrix");

const SYNC_TIMEOUT_MS = 30_000;

export interface MatrixChannelOpts {
  readonly homeserverUrl: string;
  readonly accessToken: string;
  /** Bot's full MXID, e.g. @mybot:matrix.org. Used to ignore the bot's own echoes. */
  readonly botUserId?: string;
  readonly allowedUsers?: readonly string[];
  readonly onMessage: (msg: IncomingMessage) => void;
}

interface MatrixEvent {
  event_id?: string;
  type: string;
  sender?: string;
  content?: { msgtype?: string; body?: string; "m.relates_to"?: unknown };
  origin_server_ts?: number;
}

interface RoomTimeline {
  events?: MatrixEvent[];
}

interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, { timeline?: RoomTimeline }>;
  };
}

export class MatrixChannel extends BaseChannel {
  readonly id = "matrix" as const;
  readonly name = "Matrix" as const;
  override readonly maxMessageLength = 32_000;

  private readonly homeserverUrl: string;
  private readonly accessToken: string;
  private readonly botUserId: string | undefined;
  private readonly allowedUsers: ReadonlySet<string>;
  private readonly onMessage: (msg: IncomingMessage) => void;

  private running = false;
  private syncToken: string | null = null;
  private abortController: AbortController | null = null;

  constructor(opts: MatrixChannelOpts) {
    super();
    this.homeserverUrl = opts.homeserverUrl.replace(/\/+$/, "");
    this.accessToken = opts.accessToken;
    this.botUserId = opts.botUserId;
    this.allowedUsers = new Set(opts.allowedUsers ?? []);
    this.onMessage = opts.onMessage;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async start(): Promise<void> {
    this.running = true;
    this.abortController = new AbortController();
    // Initial sync to discover current position, then loop long-polls.
    void this.syncLoop().catch((err) => {
      if (!(err as Error).name?.includes("Abort")) {
        log.error({ err }, "matrix sync loop crashed");
      }
    });
    log.info({ homeserver: this.homeserverUrl }, "matrix channel started");
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
    log.info("matrix channel stopped");
  }

  override isAllowed(userId: string): boolean {
    if (this.allowedUsers.size === 0) return true;
    return this.allowedUsers.has(userId);
  }

  // ── Outbound ────────────────────────────────────────────────────

  override async sendReply(meta: ChannelMeta, text: string): Promise<void> {
    const roomId = meta.roomId as string | undefined ?? meta.chatId;
    if (!roomId) throw new Error("Matrix reply needs roomId in channelMeta");
    // Matrix messages can be huge but splitting keeps reading comfortable.
    const chunks = text.match(/[\s\S]{1,4000}/g) ?? [text];
    for (const chunk of chunks) {
      await this.sendMessage(roomId, chunk);
    }
  }

  private async sendMessage(roomId: string, text: string): Promise<void> {
    const txnId = `daemora-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const url = `${this.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.accessToken}` },
      body: JSON.stringify({ msgtype: "m.text", body: text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log.error({ status: res.status, body }, "matrix send failed");
    }
  }

  // ── Sync loop ───────────────────────────────────────────────────

  private async syncLoop(): Promise<void> {
    while (this.running) {
      try {
        const params = new URLSearchParams({
          timeout: String(SYNC_TIMEOUT_MS),
          access_token: this.accessToken,
        });
        if (this.syncToken) params.set("since", this.syncToken);
        else params.set("filter", JSON.stringify({ room: { timeline: { limit: 0 } } }));

        const res = await fetch(`${this.homeserverUrl}/_matrix/client/v3/sync?${params.toString()}`, {
          method: "GET",
          signal: this.abortController?.signal ?? null,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          log.warn({ status: res.status, body }, "matrix sync bad status");
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        const data = (await res.json()) as SyncResponse;
        this.syncToken = data.next_batch;
        for (const [roomId, room] of Object.entries(data.rooms?.join ?? {})) {
          for (const event of room.timeline?.events ?? []) {
            this.handleEvent(roomId, event);
          }
        }
      } catch (e) {
        if (!this.running) break;
        const err = e as Error;
        if (err.name === "AbortError") break;
        log.error({ err: err.message }, "matrix sync error");
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  private handleEvent(roomId: string, event: MatrixEvent): void {
    if (event.type !== "m.room.message") return;
    if (event.content?.msgtype !== "m.text") return;
    const sender = event.sender ?? "";
    if (this.botUserId && sender === this.botUserId) return;
    if (!this.isAllowed(sender)) return;
    const body = event.content.body?.trim();
    if (!body) return;

    const incoming: IncomingMessage = {
      channel: this.id,
      userId: sender,
      text: body,
      meta: {
        channel: this.id,
        userId: sender,
        roomId,
        chatId: roomId,
        ...(event.event_id ? { messageId: event.event_id } : {}),
      },
      timestamp: event.origin_server_ts ?? Date.now(),
    };
    this.onMessage(incoming);
  }
}
