/**
 * ChannelRegistry — manages messaging channel integrations.
 *
 * A channel receives messages from an external platform (Telegram,
 * Slack, Discord, etc.), normalizes them, enqueues tasks, and sends
 * responses back. Each channel:
 *   - Has a definition (what env vars it needs, how to set up)
 *   - Can be configured (env vars set in vault/settings)
 *   - Can be started/stopped at runtime
 *
 * The registry holds the definitions + configuration state. Actual
 * channel implementations (TelegramChannel, SlackChannel, etc.) are
 * separate classes that extend BaseChannel — built on demand when
 * the feature is needed.
 */

import type Database from "better-sqlite3";

import { createLogger } from "../util/logger.js";

const log = createLogger("channels");

export interface ChannelDef {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly description: string;
  /** Env vars / vault keys needed to configure this channel. */
  readonly requiredKeys: readonly { key: string; label: string; secret: boolean }[];
  /** Whether this channel is implemented in the TS backend. */
  readonly implemented: boolean;
}

export interface ChannelStatus {
  readonly id: string;
  readonly name: string;
  readonly configured: boolean;
  readonly running: boolean;
  readonly missingKeys: readonly string[];
}

export interface ChannelDestination {
  readonly channel: string;
  readonly userId: string;
  readonly channelMeta: Record<string, unknown>;
  readonly updatedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channel_routing (
  channel    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  meta       TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel, user_id)
);
`;

/** All supported channels — matches the JS channelDefs.js registry. */
const CHANNEL_DEFS: readonly ChannelDef[] = [
  { id: "telegram", name: "Telegram", icon: "send", description: "Bot via @BotFather", requiredKeys: [{ key: "TELEGRAM_BOT_TOKEN", label: "Bot Token", secret: true }], implemented: false },
  { id: "whatsapp", name: "WhatsApp", icon: "phone", description: "Via Twilio (sandbox or dedicated number)", requiredKeys: [{ key: "TWILIO_ACCOUNT_SID", label: "Account SID", secret: true }, { key: "TWILIO_AUTH_TOKEN", label: "Auth Token", secret: true }], implemented: false },
  { id: "discord", name: "Discord", icon: "message-circle", description: "Bot via Discord Developer Portal", requiredKeys: [{ key: "DISCORD_BOT_TOKEN", label: "Bot Token", secret: true }], implemented: false },
  { id: "slack", name: "Slack", icon: "hash", description: "Socket Mode bot", requiredKeys: [{ key: "SLACK_BOT_TOKEN", label: "Bot Token", secret: true }, { key: "SLACK_APP_TOKEN", label: "App Token", secret: true }], implemented: false },
  { id: "email", name: "Email", icon: "mail", description: "Gmail IMAP/SMTP (reads + sends)", requiredKeys: [{ key: "EMAIL_USER", label: "Email Address", secret: false }, { key: "EMAIL_PASSWORD", label: "App Password", secret: true }], implemented: false },
  { id: "line", name: "LINE", icon: "message-square", description: "LINE Messaging API", requiredKeys: [{ key: "LINE_CHANNEL_ACCESS_TOKEN", label: "Channel Access Token", secret: true }, { key: "LINE_CHANNEL_SECRET", label: "Channel Secret", secret: true }], implemented: false },
  { id: "signal", name: "Signal", icon: "shield", description: "signal-cli REST daemon", requiredKeys: [{ key: "SIGNAL_CLI_URL", label: "signal-cli URL", secret: false }, { key: "SIGNAL_PHONE_NUMBER", label: "Phone Number", secret: false }], implemented: false },
  { id: "teams", name: "Microsoft Teams", icon: "users", description: "Azure Bot Framework", requiredKeys: [{ key: "TEAMS_APP_ID", label: "App ID", secret: false }, { key: "TEAMS_APP_PASSWORD", label: "App Password", secret: true }], implemented: false },
  { id: "googlechat", name: "Google Chat", icon: "message-circle", description: "Google Cloud service account", requiredKeys: [{ key: "GOOGLE_CHAT_SERVICE_ACCOUNT", label: "Service Account JSON", secret: true }], implemented: false },
  { id: "matrix", name: "Matrix", icon: "grid", description: "Element / matrix.org protocol", requiredKeys: [{ key: "MATRIX_HOMESERVER_URL", label: "Homeserver URL", secret: false }, { key: "MATRIX_ACCESS_TOKEN", label: "Access Token", secret: true }], implemented: false },
  { id: "mattermost", name: "Mattermost", icon: "server", description: "WebSocket bot", requiredKeys: [{ key: "MATTERMOST_URL", label: "Server URL", secret: false }, { key: "MATTERMOST_TOKEN", label: "Bot Token", secret: true }], implemented: false },
  { id: "twitch", name: "Twitch", icon: "tv", description: "Chat commands (!ask prefix)", requiredKeys: [{ key: "TWITCH_BOT_USERNAME", label: "Bot Username", secret: false }, { key: "TWITCH_OAUTH_TOKEN", label: "OAuth Token", secret: true }, { key: "TWITCH_CHANNEL", label: "Channel", secret: false }], implemented: false },
  { id: "irc", name: "IRC", icon: "terminal", description: "Any IRC network - no external packages", requiredKeys: [{ key: "IRC_SERVER", label: "Server", secret: false }, { key: "IRC_NICK", label: "Nickname", secret: false }], implemented: false },
  { id: "feishu", name: "Feishu / Lark", icon: "globe", description: "Bytedance enterprise messaging", requiredKeys: [{ key: "FEISHU_APP_ID", label: "App ID", secret: false }, { key: "FEISHU_APP_SECRET", label: "App Secret", secret: true }], implemented: false },
  { id: "zalo", name: "Zalo", icon: "globe", description: "Vietnam - 75M+ users", requiredKeys: [{ key: "ZALO_APP_ID", label: "App ID", secret: false }, { key: "ZALO_ACCESS_TOKEN", label: "Access Token", secret: true }], implemented: false },
  { id: "nextcloud", name: "Nextcloud Talk", icon: "cloud", description: "Self-hosted collaboration", requiredKeys: [{ key: "NEXTCLOUD_URL", label: "Server URL", secret: false }, { key: "NEXTCLOUD_USER", label: "Username", secret: false }, { key: "NEXTCLOUD_PASSWORD", label: "Password", secret: true }], implemented: false },
  { id: "bluebubbles", name: "BlueBubbles", icon: "smartphone", description: "iMessage relay server (Mac required)", requiredKeys: [{ key: "BLUEBUBBLES_URL", label: "Server URL", secret: false }, { key: "BLUEBUBBLES_PASSWORD", label: "Password", secret: true }], implemented: false },
  { id: "nostr", name: "Nostr", icon: "radio", description: "Decentralized protocol - NIP-04 encrypted DMs", requiredKeys: [{ key: "NOSTR_PRIVATE_KEY", label: "Private Key (nsec)", secret: true }], implemented: false },
];

export class ChannelRegistry {
  private readonly db: Database.Database;
  private readonly checkKey: (key: string) => boolean;

  constructor(db: Database.Database, checkKey: (key: string) => boolean) {
    this.db = db;
    this.checkKey = checkKey;
    db.exec(SCHEMA);
  }

  /** All channel definitions — what's supported. */
  defs(): readonly ChannelDef[] {
    return CHANNEL_DEFS;
  }

  /** Status of each channel — configured + running state. */
  list(): readonly ChannelStatus[] {
    return CHANNEL_DEFS.map((def) => {
      const missing = def.requiredKeys.filter((k) => !this.checkKey(k.key)).map((k) => k.key);
      return {
        id: def.id,
        name: def.name,
        configured: missing.length === 0,
        running: false, // channels aren't started in v1
        missingKeys: missing,
      };
    });
  }

  /** Saved routing destinations (for delivery presets). */
  destinations(): readonly ChannelDestination[] {
    const rows = this.db
      .prepare("SELECT channel, user_id AS userId, meta, updated_at AS updatedAt FROM channel_routing ORDER BY updated_at DESC")
      .all() as { channel: string; userId: string; meta: string; updatedAt: number }[];
    return rows.map((r) => ({
      channel: r.channel,
      userId: r.userId,
      channelMeta: JSON.parse(r.meta) as Record<string, unknown>,
      updatedAt: r.updatedAt,
    }));
  }

  /** Save a routing destination (called when a message comes in). */
  saveDestination(channel: string, userId: string, meta: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO channel_routing (channel, user_id, meta, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(channel, user_id) DO UPDATE SET meta=excluded.meta, updated_at=excluded.updated_at`,
      )
      .run(channel, userId, JSON.stringify(meta), Date.now());
  }
}
