/**
 * ChannelManager — owns channel lifecycle + streams agent replies out.
 *
 * Responsibilities:
 *   1. On startAll(), walk CHANNEL_DEFS and instantiate any channel
 *      whose secrets are present. Each channel's onMessage callback is
 *      wired to TaskRunner + a per-task streaming subscription.
 *   2. For streaming-capable channels, pipe `task:text:delta` events
 *      through a throttled StreamingEditor so the draft message is
 *      edited in place (no per-token API spam).
 *   3. On task completion, if streaming delivered nothing, send the
 *      final reply as a plain chunked message. If it DID stream, skip
 *      the duplicate.
 *   4. On stopAll(), close sockets, cancel pollers, drain timers.
 *
 * Only started channels are "running"; a channel with missing secrets
 * stays stopped until its secrets are added + start() is called.
 */

import type { ConfigManager } from "../config/ConfigManager.js";
import type { EventBus } from "../events/eventBus.js";
import type { InboundDebouncer } from "../core/InboundDebouncer.js";
import type { TaskRunner } from "../core/TaskRunner.js";
import { createLogger } from "../util/logger.js";
import { BaseChannel, type ChannelMeta, type IncomingMessage } from "./BaseChannel.js";
import type { ChannelRegistry } from "./ChannelRegistry.js";
import { DiscordChannel } from "./DiscordChannel.js";
import { EmailChannel } from "./EmailChannel.js";
import { FeishuChannel } from "./FeishuChannel.js";
import { IRCChannel } from "./IRCChannel.js";
import { GoogleChatChannel } from "./GoogleChatChannel.js";
import { BlueBubblesChannel } from "./BlueBubblesChannel.js";
import { LineChannel } from "./LineChannel.js";
import { MatrixChannel } from "./MatrixChannel.js";
import { MattermostChannel } from "./MattermostChannel.js";
import { NextcloudChannel } from "./NextcloudChannel.js";
import { SignalChannel } from "./SignalChannel.js";
import { SlackChannel } from "./SlackChannel.js";
import { TwitchChannel } from "./TwitchChannel.js";
import { ZaloChannel } from "./ZaloChannel.js";
import {
  createStreamingLoop,
  splitMessage,
  type StreamingLoop,
} from "./StreamingEditor.js";
import { TelegramChannel } from "./TelegramChannel.js";
import { WhatsAppChannel } from "./WhatsAppChannel.js";

const log = createLogger("channels.manager");

/**
 * Shared session id used by every inbound channel message AND the web
 * Chat page. The UI calls POST /api/sessions with { sessionId: "main" }
 * and then watches that session — funneling Discord / Telegram / Slack
 * traffic into the same id means everything lands in one thread.
 */
const CHANNELS_SESSION_ID = "main";

// Throttle per platform — Discord is strict (10 edits / 10s), Slack/Telegram are looser.
const STREAM_THROTTLE_MS: Record<string, number> = {
  discord: 1200,
  slack: 1000,
  telegram: 1000,
};
const DEFAULT_STREAM_THROTTLE_MS = 1500;

interface StreamState {
  readonly channel: BaseChannel;
  readonly channelMeta: ChannelMeta;
  buffer: string;
  firstMessageId: string | null;
  failed: boolean;
  stopped: boolean;
  readonly editor: StreamingLoop;
}

type ChannelFactoryCtx = {
  readonly cfg: ConfigManager;
  readonly getSecret: (key: string) => string | undefined;
  readonly onMessage: (channelId: string, msg: IncomingMessage) => void;
};

/** Build a channel instance from its id, or null if unsupported in v1. */
type ChannelFactory = (ctx: ChannelFactoryCtx) => BaseChannel | null;

const CHANNEL_FACTORIES: Record<string, ChannelFactory> = {
  discord: ({ getSecret, onMessage }) => {
    const token = getSecret("DISCORD_BOT_TOKEN");
    if (!token) return null;
    return new DiscordChannel({ token, onMessage: (m) => onMessage("discord", m) });
  },
  telegram: ({ getSecret, onMessage, cfg }) => {
    const token = getSecret("TELEGRAM_BOT_TOKEN");
    if (!token) return null;
    return new TelegramChannel({ token, cfg, onMessage: (m) => onMessage("telegram", m) });
  },
  slack: ({ getSecret, onMessage }) => {
    const botToken = getSecret("SLACK_BOT_TOKEN");
    const appToken = getSecret("SLACK_APP_TOKEN");
    if (!botToken || !appToken) return null;
    return new SlackChannel({ botToken, appToken, onMessage: (m) => onMessage("slack", m) });
  },
  whatsapp: ({ getSecret, onMessage }) => {
    const sid = getSecret("TWILIO_ACCOUNT_SID");
    const tok = getSecret("TWILIO_AUTH_TOKEN");
    const from = getSecret("TWILIO_WHATSAPP_FROM") ?? getSecret("TWILIO_FROM");
    if (!sid || !tok || !from) return null;
    return new WhatsAppChannel({
      accountSid: sid,
      authToken: tok,
      from,
      onMessage: (m) => onMessage("whatsapp", m),
    });
  },
  line: ({ getSecret, onMessage }) => {
    const accessToken = getSecret("LINE_CHANNEL_ACCESS_TOKEN");
    const channelSecret = getSecret("LINE_CHANNEL_SECRET");
    if (!accessToken || !channelSecret) return null;
    return new LineChannel({
      accessToken,
      channelSecret,
      onMessage: (m) => onMessage("line", m),
    });
  },
  feishu: ({ getSecret, onMessage }) => {
    const appId = getSecret("FEISHU_APP_ID");
    const appSecret = getSecret("FEISHU_APP_SECRET");
    if (!appId || !appSecret) return null;
    const verificationToken = getSecret("FEISHU_VERIFICATION_TOKEN");
    return new FeishuChannel({
      appId,
      appSecret,
      ...(verificationToken ? { verificationToken } : {}),
      onMessage: (m) => onMessage("feishu", m),
    });
  },
  email: ({ getSecret, onMessage }) => {
    // Inbound IMAP needs EMAIL_USER + EMAIL_PASSWORD. Outbound can be
    // satisfied by either those same credentials (via SMTP) or a Resend
    // API key. If neither side is configured, the channel stays dark.
    const user = getSecret("EMAIL_USER");
    const password = getSecret("EMAIL_PASSWORD");
    const resendApiKey = getSecret("RESEND_API_KEY");
    if (!user && !resendApiKey) return null;
    if (!user || !password) {
      // Outbound-only (Resend) isn't useful without an inbound source,
      // so we require IMAP creds if we're starting the channel at all.
      return null;
    }
    return new EmailChannel({
      user,
      password,
      ...(resendApiKey ? { resendApiKey } : {}),
      ...(getSecret("RESEND_FROM") ? { resendFrom: getSecret("RESEND_FROM") as string } : {}),
      onMessage: (m) => onMessage("email", m),
    });
  },
  matrix: ({ getSecret, onMessage }) => {
    const homeserverUrl = getSecret("MATRIX_HOMESERVER_URL");
    const accessToken = getSecret("MATRIX_ACCESS_TOKEN");
    if (!homeserverUrl || !accessToken) return null;
    const botUserId = getSecret("MATRIX_BOT_USER_ID");
    return new MatrixChannel({
      homeserverUrl,
      accessToken,
      ...(botUserId ? { botUserId } : {}),
      onMessage: (m) => onMessage("matrix", m),
    });
  },
  mattermost: ({ getSecret, onMessage }) => {
    const url = getSecret("MATTERMOST_URL");
    const token = getSecret("MATTERMOST_TOKEN");
    const botUserId = getSecret("MATTERMOST_BOT_USER_ID");
    if (!url || !token || !botUserId) return null;
    const botUsername = getSecret("MATTERMOST_BOT_USERNAME");
    return new MattermostChannel({
      url,
      token,
      botUserId,
      ...(botUsername ? { botUsername } : {}),
      onMessage: (m) => onMessage("mattermost", m),
    });
  },
  twitch: ({ getSecret, onMessage }) => {
    const username = getSecret("TWITCH_BOT_USERNAME");
    const token = getSecret("TWITCH_OAUTH_TOKEN");
    const channel = getSecret("TWITCH_CHANNEL");
    if (!username || !token || !channel) return null;
    return new TwitchChannel({
      username, token, channel,
      onMessage: (m) => onMessage("twitch", m),
    });
  },
  irc: ({ getSecret, onMessage }) => {
    const server = getSecret("IRC_SERVER");
    const nick = getSecret("IRC_NICK");
    if (!server || !nick) return null;
    const portRaw = getSecret("IRC_PORT");
    const port = portRaw ? Number.parseInt(portRaw, 10) : undefined;
    const channel = getSecret("IRC_CHANNEL");
    const password = getSecret("IRC_PASSWORD");
    const prefix = getSecret("IRC_COMMAND_PREFIX");
    return new IRCChannel({
      server, nick,
      ...(typeof port === "number" && !Number.isNaN(port) ? { port } : {}),
      ...(channel ? { channel } : {}),
      ...(password ? { password } : {}),
      ...(prefix ? { prefix } : {}),
      onMessage: (m) => onMessage("irc", m),
    });
  },
  bluebubbles: ({ getSecret, onMessage }) => {
    const url = getSecret("BLUEBUBBLES_URL");
    const password = getSecret("BLUEBUBBLES_PASSWORD");
    if (!url || !password) return null;
    return new BlueBubblesChannel({
      url, password,
      onMessage: (m) => onMessage("bluebubbles", m),
    });
  },
  signal: ({ getSecret, onMessage }) => {
    const cliUrl = getSecret("SIGNAL_CLI_URL");
    const phoneNumber = getSecret("SIGNAL_PHONE_NUMBER");
    if (!cliUrl || !phoneNumber) return null;
    return new SignalChannel({
      cliUrl, phoneNumber,
      onMessage: (m) => onMessage("signal", m),
    });
  },
  zalo: ({ getSecret, onMessage }) => {
    const appId = getSecret("ZALO_APP_ID");
    const appSecret = getSecret("ZALO_APP_SECRET");
    const accessToken = getSecret("ZALO_ACCESS_TOKEN");
    if (!appId || !appSecret || !accessToken) return null;
    return new ZaloChannel({
      appId, appSecret, accessToken,
      onMessage: (m) => onMessage("zalo", m),
    });
  },
  nextcloud: ({ getSecret, onMessage }) => {
    const url = getSecret("NEXTCLOUD_URL");
    const user = getSecret("NEXTCLOUD_USER");
    const password = getSecret("NEXTCLOUD_PASSWORD");
    if (!url || !user || !password) return null;
    const roomToken = getSecret("NEXTCLOUD_ROOM_TOKEN");
    return new NextcloudChannel({
      url, user, password,
      ...(roomToken ? { roomToken } : {}),
      onMessage: (m) => onMessage("nextcloud", m),
    });
  },
  googlechat: ({ getSecret, onMessage }) => {
    const saRaw = getSecret("GOOGLE_CHAT_SERVICE_ACCOUNT");
    if (!saRaw) return null;
    try {
      const sa = JSON.parse(saRaw) as { client_email: string; private_key: string; token_uri?: string };
      if (!sa.client_email || !sa.private_key) return null;
      return new GoogleChatChannel({
        serviceAccount: sa,
        onMessage: (m) => onMessage("googlechat", m),
      });
    } catch (err) {
      log.error({ err: (err as Error).message }, "googlechat: invalid service account JSON");
      return null;
    }
  },
};

export class ChannelManager {
  private readonly running = new Map<string, BaseChannel>();
  private readonly streams = new Map<string, StreamState>();
  /**
   * Per-task routing info — captured on `spawnTask` so the `send_file`
   * tool (called mid-turn by the agent) can look up the originating
   * channel + user/chat metadata without the agent needing to pass it.
   * Entries are cleared when the task's final reply lands.
   */
  private readonly taskChannels = new Map<string, { channel: BaseChannel; meta: ChannelMeta }>();
  private disposed = false;

  constructor(
    private readonly registry: ChannelRegistry,
    private readonly cfg: ConfigManager,
    private readonly runner: TaskRunner,
    private readonly bus: EventBus,
    private readonly debouncer?: InboundDebouncer,
  ) {
    this.bus.on("task:text:delta", (ev) => this.onTextDelta(ev.taskId, ev.delta));
    this.bus.on("task:text:end", (ev) => this.onTextEnd(ev.taskId, ev.finalText));
    this.bus.on("task:reply:needed", (ev) => {
      void this.deliverFinal(ev.taskId, ev.channel, ev.channelMeta, ev.text, ev.failed);
    });
  }

  /**
   * Upload a local file to whatever channel spawned `taskId`. Called by
   * the `send_file` core tool. Returns a human-readable status so the
   * agent can decide what to say in its final reply.
   */
  async sendFileForTask(
    taskId: string,
    path: string,
    caption?: string,
  ): Promise<{ ok: boolean; message: string }> {
    const entry = this.taskChannels.get(taskId);
    if (!entry) {
      return { ok: false, message: "No active channel for this task — nothing to upload to." };
    }
    if (!entry.channel.supportsFiles) {
      return { ok: false, message: `Channel "${entry.channel.id}" doesn't support file uploads.` };
    }
    try {
      await entry.channel.sendFile(entry.meta, path, caption);
      return { ok: true, message: `File delivered via ${entry.channel.id}.` };
    } catch (e) {
      return { ok: false, message: `Upload failed: ${(e as Error).message}` };
    }
  }

  // ── Public API ─────────────────────────────────────────────────

  /** Instantiate + start every channel that has its secrets configured. */
  async startAll(): Promise<void> {
    const ctx: ChannelFactoryCtx = {
      cfg: this.cfg,
      getSecret: (key) => this.readSecret(key),
      onMessage: (id, msg) => this.handleIncoming(id, msg),
    };

    for (const def of this.registry.defs()) {
      if (this.running.has(def.id)) continue; // defense in depth — skip live instances
      const factory = CHANNEL_FACTORIES[def.id];
      if (!factory) continue; // not implemented yet
      const channel = factory(ctx);
      if (!channel) {
        log.debug({ id: def.id }, "channel skipped — secrets missing");
        continue;
      }
      await this.startChannel(channel);
    }
    log.info({ running: this.running.size }, "channels running");
  }

  /** Start a single channel by id. Returns true on success. */
  async start(id: string): Promise<boolean> {
    if (this.running.has(id)) return true;
    const def = this.registry.defs().find((d) => d.id === id);
    if (!def) return false;
    const factory = CHANNEL_FACTORIES[id];
    if (!factory) return false;
    const channel = factory({
      cfg: this.cfg,
      getSecret: (key) => this.readSecret(key),
      onMessage: (cid, msg) => this.handleIncoming(cid, msg),
    });
    if (!channel) return false;
    await this.startChannel(channel);
    return true;
  }

  /** Stop a single channel by id. */
  async stop(id: string): Promise<boolean> {
    const ch = this.running.get(id);
    if (!ch) return false;
    try {
      await ch.stop();
    } catch (err) {
      log.error({ id, err: (err as Error).message }, "channel stop failed");
    }
    this.running.delete(id);
    return true;
  }

  /** Stop every running channel. Safe to call on shutdown. */
  async stopAll(): Promise<void> {
    this.disposed = true;
    for (const [id, ch] of this.running.entries()) {
      try {
        await ch.stop();
      } catch (err) {
        log.error({ id, err: (err as Error).message }, "channel stop failed");
      }
    }
    this.running.clear();
    for (const s of this.streams.values()) {
      s.stopped = true;
      s.editor.stop();
    }
    this.streams.clear();
  }

  /** Status snapshot — running state by channel id. */
  runningSet(): ReadonlySet<string> {
    return new Set(this.running.keys());
  }

  /** Grab a live channel instance (or null if that channel isn't running). */
  getChannel(id: string): BaseChannel | null {
    return this.running.get(id) ?? null;
  }

  /** Dispatch a webhook request to the right channel by id. */
  async dispatchWebhook(
    id: string,
    req: import("./BaseChannel.js").WebhookRequest,
    res: import("./BaseChannel.js").WebhookResponse,
    rawBody: string | null,
  ): Promise<boolean> {
    const ch = this.running.get(id);
    if (!ch) return false;
    await ch.handleWebhook(req, res, rawBody);
    return true;
  }

  /** List each defined channel's running state (for UI / /api/channels). */
  statusList(): { id: string; running: boolean; implemented: boolean }[] {
    return this.registry.defs().map((d) => ({
      id: d.id,
      running: this.running.has(d.id),
      implemented: CHANNEL_FACTORIES[d.id] != null,
    }));
  }

  // ── Internals ──────────────────────────────────────────────────

  private async startChannel(channel: BaseChannel): Promise<void> {
    try {
      await channel.start();
      this.running.set(channel.id, channel);
      log.info({ id: channel.id }, "channel started");
    } catch (err) {
      log.error({ id: channel.id, err: (err as Error).message }, "channel failed to start");
    }
  }

  private readSecret(key: string): string | undefined {
    if (this.cfg.vault.isUnlocked()) {
      const s = this.cfg.vault.get(key);
      if (s) return s.reveal();
    }
    const g = this.cfg.settings.getGeneric(key);
    if (typeof g === "string" && g) return g;
    const env = process.env[key];
    return env && env.length > 0 ? env : undefined;
  }

  private handleIncoming(channelId: string, msg: IncomingMessage): void {
    if (this.disposed) return;
    const channel = this.running.get(channelId);
    if (!channel) return;

    // Single shared session across ALL channel traffic so the agent keeps
    // one continuous conversation regardless of which channel / user
    // sent the message. Per-user isolation is not used here.
    const sessionId = CHANNELS_SESSION_ID;

    // Record destination early so even bundled-into-previous-batch sends
    // land correctly.
    this.registry.saveDestination(channelId, msg.userId, msg.meta);

    // Debounce rapid-fire messages from the same (channel, user) pair
    // into a single task. The first caller's promise resolves with the
    // batched text; later callers get null and must NOT spawn a task.
    if (this.debouncer) {
      const key = `${channelId}:${msg.userId ?? "unknown"}`;
      void this.debouncer.debounce(key, msg.text).then((batched) => {
        if (batched === null) return; // bundled into an earlier caller's batch
        // Attachments bypass debouncing — they belong to the first
        // message they arrived with, not the batched text.
        this.spawnTask(channel, channelId, batched, msg.meta, sessionId, msg.attachments);
      });
      return;
    }
    this.spawnTask(channel, channelId, msg.text, msg.meta, sessionId, msg.attachments);
  }

  private spawnTask(
    channel: BaseChannel,
    channelId: string,
    text: string,
    meta: ChannelMeta,
    sessionId: string,
    attachments?: IncomingMessage["attachments"],
  ): void {
    const handle = this.runner.run({
      input: text,
      sessionId,
      channel: channelId,
      channelMeta: meta,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });
    // Remember where this task came from so `send_file` can target the
    // same conversation. Cleared when the task's final reply lands.
    this.taskChannels.set(handle.taskId, { channel, meta });
    if (channel.supportsStreaming) {
      this.beginStreaming(handle.taskId, channel, meta);
    }
    void channel.sendTyping(meta).catch(() => {});
  }

  private beginStreaming(
    taskId: string,
    channel: BaseChannel,
    channelMeta: ChannelMeta,
  ): void {
    const state: StreamState = {
      channel,
      channelMeta,
      buffer: "",
      firstMessageId: null,
      failed: false,
      stopped: false,
      editor: null as unknown as StreamingLoop,
    };
    const throttleMs = STREAM_THROTTLE_MS[channel.id] ?? DEFAULT_STREAM_THROTTLE_MS;
    const editor = createStreamingLoop({
      throttleMs,
      isStopped: () => state.stopped,
      sendOrEdit: async (text) => {
        if (text.length > channel.maxMessageLength) {
          state.failed = true;
          return false;
        }
        try {
          const id = await channel.sendOrEditStream(channelMeta, text, state.firstMessageId);
          if (id) state.firstMessageId = id;
          return true;
        } catch (err) {
          log.error({ id: channel.id, err: (err as Error).message }, "stream edit failed");
          state.failed = true;
          return false;
        }
      },
    });
    (state as { editor: StreamingLoop }).editor = editor;
    this.streams.set(taskId, state);
  }

  private onTextDelta(taskId: string, delta: string): void {
    const s = this.streams.get(taskId);
    if (!s || s.stopped || s.failed) return;
    s.buffer += delta;
    s.editor.update(s.buffer);
  }

  private onTextEnd(taskId: string, finalText: string): void {
    const s = this.streams.get(taskId);
    if (!s || s.stopped) return;
    if (finalText.length >= s.buffer.length) s.buffer = finalText;
    s.editor.update(s.buffer);
  }

  /**
   * Called on task completion. If streaming delivered the full message
   * in place, we're done. Otherwise send the final reply (chunking if it
   * overflows the platform's size cap).
   */
  private async deliverFinal(
    taskId: string,
    channelId: string,
    meta: ChannelMeta,
    text: string,
    failed: boolean,
  ): Promise<void> {
    const state = this.streams.get(taskId);
    const channel = this.running.get(channelId) ?? state?.channel;
    if (!channel) return;

    if (state) {
      // Drain any pending streaming edits first so we don't fight the loop.
      try { await state.editor.flush(); } catch { /* ignore */ }
      state.stopped = true;
      state.editor.stop();
    }

    const streamed = !!state && !state.failed && state.firstMessageId !== null && !failed;
    if (streamed) {
      this.streams.delete(taskId);
      this.taskChannels.delete(taskId);
      return;
    }

    // Fallback: send as chunked message(s).
    try {
      const chunks = splitMessage(text, channel.maxMessageLength);
      for (const chunk of chunks) {
        await channel.sendReply(meta, chunk);
      }
    } catch (err) {
      log.error({ id: channelId, err: (err as Error).message }, "channel final reply failed");
    }
    this.streams.delete(taskId);
    this.taskChannels.delete(taskId);
  }
}
