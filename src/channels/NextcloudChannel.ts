/**
 * NextcloudChannel — Nextcloud Talk bot via the Spreed REST API.
 *
 * Polls every ~5 s for new messages in every DM / group room the bot
 * user participates in, then replies with POST
 * `/ocs/v2.php/apps/spreed/api/v1/chat/{token}`.
 *
 * Setup:
 *   1. Create a dedicated Nextcloud user for the bot.
 *   2. Generate an app password (Profile → Security).
 *   3. Provide NEXTCLOUD_URL, NEXTCLOUD_USER, NEXTCLOUD_PASSWORD, and
 *      optionally NEXTCLOUD_ROOM_TOKEN to restrict to one room.
 */

import { createLogger } from "../util/logger.js";
import { BaseChannel, type ChannelMeta, type IncomingMessage } from "./BaseChannel.js";

const log = createLogger("channel.nextcloud");

export interface NextcloudChannelOpts {
  readonly url: string;
  readonly user: string;
  readonly password: string;
  readonly roomToken?: string;
  readonly pollIntervalMs?: number;
  readonly allowedUsers?: readonly string[];
  readonly onMessage: (msg: IncomingMessage) => void;
}

interface NextcloudRoom {
  token: string;
  type: number;
}
interface NextcloudMessage {
  id: number;
  actorId?: string;
  messageType?: string;
  message?: string;
  timestamp?: number;
}

export class NextcloudChannel extends BaseChannel {
  readonly id = "nextcloud" as const;
  readonly name = "Nextcloud Talk" as const;
  override readonly maxMessageLength = 32_000;

  private readonly url: string;
  private readonly user: string;
  private readonly password: string;
  private readonly roomToken: string | undefined;
  private readonly pollMs: number;
  private readonly allowedUsers: ReadonlySet<string>;
  private readonly onMessage: (msg: IncomingMessage) => void;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly lastMessageIds = new Map<string, number>();

  constructor(opts: NextcloudChannelOpts) {
    super();
    this.url = opts.url.replace(/\/$/, "");
    this.user = opts.user;
    this.password = opts.password;
    this.roomToken = opts.roomToken;
    this.pollMs = opts.pollIntervalMs ?? 5_000;
    this.allowedUsers = new Set(opts.allowedUsers ?? []);
    this.onMessage = opts.onMessage;
  }

  async start(): Promise<void> {
    this.running = true;
    this.pollTimer = setInterval(() => { void this.poll(); }, this.pollMs);
    log.info({ url: this.url, intervalMs: this.pollMs }, "nextcloud polling started");
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    log.info("nextcloud channel stopped");
  }

  override async sendReply(meta: ChannelMeta, text: string): Promise<void> {
    const token = (meta.token as string | undefined) ?? (meta.chatId as string | undefined);
    if (!token) throw new Error("Nextcloud reply needs token in channelMeta");
    const chunks = text.match(/[\s\S]{1,32000}/g) ?? [text];
    for (const chunk of chunks) {
      const body = new URLSearchParams({ message: chunk });
      const res = await fetch(`${this.url}/ocs/v2.php/apps/spreed/api/v1/chat/${token}`, {
        method: "POST",
        headers: {
          ...this.headers(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
      if (!res.ok) {
        log.error({ status: res.status }, "nextcloud send failed");
      }
    }
  }

  override isAllowed(userId: string): boolean {
    if (this.allowedUsers.size === 0) return true;
    return this.allowedUsers.has(userId);
  }

  // ── Internals ───────────────────────────────────────────────────

  private headers(): Record<string, string> {
    const creds = Buffer.from(`${this.user}:${this.password}`).toString("base64");
    return {
      Authorization: `Basic ${creds}`,
      "OCS-APIRequest": "true",
      Accept: "application/json",
    };
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    try {
      const roomsRes = await fetch(`${this.url}/ocs/v2.php/apps/spreed/api/v4/room`, {
        headers: this.headers(),
      });
      if (!roomsRes.ok) return;
      const roomsData = (await roomsRes.json()) as { ocs?: { data?: NextcloudRoom[] } };
      const rooms = roomsData.ocs?.data ?? [];

      for (const room of rooms) {
        if (this.roomToken && room.token !== this.roomToken) continue;
        if (room.type !== 1 && room.type !== 3) continue; // 1=DM, 3=group

        const lastKnown = this.lastMessageIds.get(room.token) ?? 0;
        const msgsRes = await fetch(
          `${this.url}/ocs/v2.php/apps/spreed/api/v1/chat/${room.token}?lookIntoFuture=0&limit=10&lastKnownMessageId=${lastKnown}`,
          { headers: this.headers() },
        );
        if (!msgsRes.ok) continue;
        const msgsData = (await msgsRes.json()) as { ocs?: { data?: NextcloudMessage[] } };
        const messages = msgsData.ocs?.data ?? [];

        for (const msg of messages) {
          if (msg.actorId === this.user) continue;
          if (msg.messageType !== "comment") continue;
          if (msg.id <= lastKnown) continue;
          this.lastMessageIds.set(room.token, Math.max(this.lastMessageIds.get(room.token) ?? 0, msg.id));

          if (!msg.actorId || !this.isAllowed(msg.actorId)) continue;
          const text = msg.message?.trim();
          if (!text) continue;

          const incoming: IncomingMessage = {
            channel: this.id,
            userId: msg.actorId,
            text,
            meta: {
              channel: this.id,
              userId: msg.actorId,
              actorId: msg.actorId,
              token: room.token,
              chatId: room.token,
              messageId: String(msg.id),
            },
            timestamp: msg.timestamp ? msg.timestamp * 1000 : Date.now(),
          };
          this.onMessage(incoming);
        }
      }
    } catch (e) {
      log.debug({ err: (e as Error).message }, "nextcloud poll error");
    }
  }
}
