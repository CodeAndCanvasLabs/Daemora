import { HttpChannel } from "./HttpChannel.js";

// ─── Core channels ─────────────────────────────────────────────────────────────
import { TelegramChannel } from "./TelegramChannel.js";
import { WhatsAppChannel } from "./WhatsAppChannel.js";
import { EmailChannel } from "./EmailChannel.js";
import { DiscordChannel } from "./DiscordChannel.js";
import { SlackChannel } from "./SlackChannel.js";
import { LineChannel } from "./LineChannel.js";
import { SignalChannel } from "./SignalChannel.js";
import { TeamsChannel } from "./TeamsChannel.js";
import { GoogleChatChannel } from "./GoogleChatChannel.js";

// ─── Phase 24 channels ─────────────────────────────────────────────────────────
import { MatrixChannel } from "./MatrixChannel.js";
import { MattermostChannel } from "./MattermostChannel.js";
import { TwitchChannel } from "./TwitchChannel.js";
import { IRCChannel } from "./IRCChannel.js";
import { iMessageChannel } from "./iMessageChannel.js";
import { FeishuChannel } from "./FeishuChannel.js";
import { ZaloChannel } from "./ZaloChannel.js";
import { NextcloudChannel } from "./NextcloudChannel.js";
import { BlueBubblesChannel } from "./BlueBubblesChannel.js";
import { NostrChannel } from "./NostrChannel.js";

import { config } from "../config/default.js";
import eventBus from "../core/EventBus.js";
import { CHANNEL_DEFS } from "./channelDefs.js";

/**
 * Maps stored channelConfig credential keys → channel constructor params.
 * Used to spin up per-tenant channel instances from stored credentials.
 */
const TENANT_CHANNEL_BUILDERS = {
  telegram: (c) => c.TELEGRAM_BOT_TOKEN
    ? { token: c.TELEGRAM_BOT_TOKEN }
    : null,
  discord:  (c) => c.DISCORD_BOT_TOKEN
    ? { token: c.DISCORD_BOT_TOKEN }
    : null,
  slack:    (c) => c.SLACK_BOT_TOKEN && c.SLACK_APP_TOKEN
    ? { botToken: c.SLACK_BOT_TOKEN, appToken: c.SLACK_APP_TOKEN }
    : null,
  whatsapp: (c) => c.TWILIO_ACCOUNT_SID && c.TWILIO_AUTH_TOKEN
    ? { accountSid: c.TWILIO_ACCOUNT_SID, authToken: c.TWILIO_AUTH_TOKEN, from: c.TWILIO_WHATSAPP_FROM }
    : null,
  line:     (c) => c.LINE_CHANNEL_ACCESS_TOKEN && c.LINE_CHANNEL_SECRET
    ? { accessToken: c.LINE_CHANNEL_ACCESS_TOKEN, channelSecret: c.LINE_CHANNEL_SECRET }
    : null,
};

/** Required credential key(s) per channel type — used by the UI to show what to enter. */
export const TENANT_CHANNEL_CRED_KEYS = {
  telegram: ["TELEGRAM_BOT_TOKEN"],
  discord:  ["DISCORD_BOT_TOKEN"],
  slack:    ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
  whatsapp: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM"],
  line:     ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET"],
};

/**
 * Channel Registry - manages all input channels.
 * Supports both global channel instances (from .env) and per-tenant instances
 * (from tenant encryptedChannelConfig), keyed as "type::tenantId".
 */
class ChannelRegistry {
  constructor() {
    // Map<instanceKey, channelInstance>
    // Global: "discord" | Per-tenant: "discord::telegram:123456"
    this.channels = new Map();
    // Map<channelType, channelClass/factory> — plugin-registered channels
    this.pluginChannels = new Map();
  }

  /**
   * Register a plugin-provided channel implementation.
   * @param {string} name — channel type name
   * @param {Function|object} impl — channel class or factory { create(config) → instance }
   */
  registerPluginChannel(name, impl) {
    this.pluginChannels.set(name, impl);
    console.log(`[ChannelRegistry] Plugin channel registered: ${name}`);
  }

  _instanceKey(channelType, tenantId) {
    return tenantId ? `${channelType}::${tenantId}` : channelType;
  }

  _buildChannelInstance(channelType, channelConfig) {
    switch (channelType) {
      case "telegram": return new TelegramChannel({ ...channelConfig, enabled: true });
      case "discord":  return new DiscordChannel({ ...channelConfig });
      case "slack":    return new SlackChannel({ ...channelConfig });
      case "whatsapp": return new WhatsAppChannel({ ...channelConfig, enabled: true });
      case "line":     return new LineChannel({ ...channelConfig });
      default: {
        // Check plugin-registered channels
        const pluginImpl = this.pluginChannels.get(channelType);
        if (pluginImpl) {
          if (typeof pluginImpl === "function") {
            // Class constructor: new PluginChannel(config)
            return new pluginImpl(channelConfig);
          } else if (pluginImpl.create) {
            // Factory: { create(config) → instance }
            return pluginImpl.create(channelConfig);
          }
        }
        return null;
      }
    }
  }

  /**
   * Start (or restart) a per-tenant channel instance.
   * Stops the existing instance if already running, then starts fresh.
   * @param {string} tenantId
   * @param {string} channelType - "telegram" | "discord" | "slack" | "whatsapp" | "line"
   * @param {object} channelConfig - channel constructor params (token, botToken, etc.)
   * @returns {boolean} true if started successfully
   */
  async startTenantChannel(tenantId, channelType, channelConfig) {
    const key = this._instanceKey(channelType, tenantId);

    // Stop existing instance if running
    const existing = this.channels.get(key);
    if (existing) {
      try { await existing.stop(); } catch {}
      this.channels.delete(key);
    }

    const ch = this._buildChannelInstance(channelType, {
      ...channelConfig,
      tenantId,
      instanceKey: key,
    });
    if (!ch) return false;

    try {
      await ch.start();
      if (ch.running) {
        this.channels.set(key, ch);
        console.log(`[ChannelRegistry] Tenant channel started: ${key}`);
        eventBus.emit("tenant:channel:started", { tenantId, channelType, instanceKey: key });
        return true;
      }
    } catch (e) {
      console.log(`[ChannelRegistry] Failed to start tenant channel ${key}: ${e.message}`);
    }
    return false;
  }

  /**
   * Stop and remove all per-tenant channel instances for a given tenant.
   */
  async stopTenantChannels(tenantId) {
    const suffix = `::${tenantId}`;
    for (const [key, ch] of this.channels) {
      if (key.endsWith(suffix)) {
        try { await ch.stop(); } catch {}
        this.channels.delete(key);
        console.log(`[ChannelRegistry] Tenant channel stopped: ${key}`);
        eventBus.emit("tenant:channel:stopped", { tenantId, instanceKey: key });
      }
    }
  }

  /**
   * Reload all channel instances for a tenant from their stored credentials.
   * Stops stale instances and starts newly configured ones.
   * @param {string} tenantId
   * @param {object} creds - decrypted channelConfig key-value map
   */
  async reloadTenantChannels(tenantId, creds) {
    // Stop all existing tenant instances first
    await this.stopTenantChannels(tenantId);

    // Start whichever channels have valid credentials
    for (const [channelType, builder] of Object.entries(TENANT_CHANNEL_BUILDERS)) {
      const channelConfig = builder(creds);
      if (channelConfig) {
        await this.startTenantChannel(tenantId, channelType, channelConfig);
      }
    }
  }

  /**
   * Load channel instances for all tenants that have stored credentials.
   * Called once on startup after global channels are started.
   */
  async loadTenantChannels() {
    // Lazy import to avoid circular dep at module-load time
    const { default: tenantManager } = await import("../tenants/TenantManager.js");
    const tenants = tenantManager.list();
    let started = 0;
    for (const tenant of tenants) {
      const creds = tenantManager.getDecryptedChannelConfig(tenant.id);
      if (!creds || Object.keys(creds).length === 0) continue;
      for (const [channelType, builder] of Object.entries(TENANT_CHANNEL_BUILDERS)) {
        const channelConfig = builder(creds);
        if (channelConfig) {
          const ok = await this.startTenantChannel(tenant.id, channelType, channelConfig);
          if (ok) started++;
        }
      }
    }
    if (started > 0) console.log(`[ChannelRegistry] ${started} per-tenant channel(s) started`);
  }

  /**
   * Initialize and start all enabled channels.
   */
  async startAll() {
    // ─── HTTP channel (Securely handled by Express routes in index.js) ────────
    const http = new HttpChannel(config.channels.http);
    this.channels.set("http", http);
    await http.start();
    // ─────────────────────────────────────────────────────────────────────────

    // ── Core channels ─────────────────────────────────────────────────────────

    // Telegram
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    if (telegramToken) {
      try {
        const telegram = new TelegramChannel({ ...config.channels.telegram, enabled: true, token: telegramToken });
        this.channels.set("telegram", telegram);
        await telegram.start();
      } catch (e) {
        console.log(`[Channel:Telegram] Failed to start: ${e.message}`);
      }
    }

    // WhatsApp
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    if (twilioSid) {
      const whatsapp = new WhatsAppChannel({
        ...config.channels.whatsapp,
        enabled: true,
        accountSid: twilioSid,
        authToken: process.env.TWILIO_AUTH_TOKEN,
        from: process.env.TWILIO_WHATSAPP_FROM,
      });
      this.channels.set("whatsapp", whatsapp);
      await whatsapp.start();
    }

    // Email
    const emailUser = process.env.EMAIL_USER;
    if (emailUser) {
      const email = new EmailChannel({
        ...config.channels.email,
        enabled: true,
        user: emailUser,
        password: process.env.EMAIL_PASSWORD,
      });
      this.channels.set("email", email);
      await email.start();
    }

    // Discord
    const discordToken = process.env.DISCORD_BOT_TOKEN;
    if (discordToken) {
      try {
        const discord = new DiscordChannel({ token: discordToken });
        this.channels.set("discord", discord);
        await discord.start();
      } catch (e) {
        console.log(`[Channel:Discord] Failed to start: ${e.message}`);
      }
    }

    // Slack
    const slackBotToken = process.env.SLACK_BOT_TOKEN;
    const slackAppToken = process.env.SLACK_APP_TOKEN;
    if (slackBotToken && slackAppToken) {
      try {
        const slack = new SlackChannel({ botToken: slackBotToken, appToken: slackAppToken });
        this.channels.set("slack", slack);
        await slack.start();
      } catch (e) {
        console.log(`[Channel:Slack] Failed to start: ${e.message}`);
      }
    }

    // LINE
    const lineAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const lineSecret = process.env.LINE_CHANNEL_SECRET;
    if (lineAccessToken && lineSecret) {
      try {
        const line = new LineChannel({ accessToken: lineAccessToken, channelSecret: lineSecret });
        this.channels.set("line", line);
        await line.start();
      } catch (e) {
        console.log(`[Channel:LINE] Failed to start: ${e.message}`);
      }
    }

    // Signal
    const signalCliUrl = process.env.SIGNAL_CLI_URL;
    const signalPhone = process.env.SIGNAL_PHONE_NUMBER;
    if (signalCliUrl && signalPhone) {
      try {
        const signal = new SignalChannel({ cliUrl: signalCliUrl, phoneNumber: signalPhone });
        this.channels.set("signal", signal);
        await signal.start();
      } catch (e) {
        console.log(`[Channel:Signal] Failed to start: ${e.message}`);
      }
    }

    // Microsoft Teams
    const teamsAppId = process.env.TEAMS_APP_ID;
    const teamsAppPwd = process.env.TEAMS_APP_PASSWORD;
    if (teamsAppId && teamsAppPwd) {
      try {
        const teams = new TeamsChannel({
          ...config.channels.teams,
          appId: teamsAppId,
          appPassword: teamsAppPwd,
        });
        this.channels.set("teams", teams);
        await teams.start();
      } catch (e) {
        console.log(`[Channel:Teams] Failed to start: ${e.message}`);
      }
    }

    // Google Chat
    const googleServiceAccount = process.env.GOOGLE_CHAT_SERVICE_ACCOUNT;
    if (googleServiceAccount) {
      try {
        const googleChat = new GoogleChatChannel({
          ...config.channels.googlechat,
          serviceAccount: googleServiceAccount,
          projectNumber: process.env.GOOGLE_CHAT_PROJECT_NUMBER,
        });
        this.channels.set("googlechat", googleChat);
        await googleChat.start();
      } catch (e) {
        console.log(`[Channel:GoogleChat] Failed to start: ${e.message}`);
      }
    }

    // ── Phase 24 channels ──────────────────────────────────────────────────────

    // Matrix
    const matrixHomeserver = process.env.MATRIX_HOMESERVER_URL;
    const matrixToken = process.env.MATRIX_ACCESS_TOKEN;
    if (matrixHomeserver && matrixToken) {
      try {
        const matrix = new MatrixChannel({
          homeserverUrl: matrixHomeserver,
          accessToken: matrixToken,
          botUserId: process.env.MATRIX_BOT_USER_ID,
        });
        this.channels.set("matrix", matrix);
        await matrix.start();
      } catch (e) {
        console.log(`[Channel:Matrix] Failed to start: ${e.message}`);
      }
    }

    // Mattermost
    const mmUrl = process.env.MATTERMOST_URL;
    const mmToken = process.env.MATTERMOST_TOKEN;
    if (mmUrl && mmToken) {
      try {
        const mattermost = new MattermostChannel({
          url: mmUrl,
          token: mmToken,
          botUserId: process.env.MATTERMOST_BOT_USER_ID,
          botUsername: process.env.MATTERMOST_BOT_USERNAME,
        });
        this.channels.set("mattermost", mattermost);
        await mattermost.start();
      } catch (e) {
        console.log(`[Channel:Mattermost] Failed to start: ${e.message}`);
      }
    }

    // Twitch
    const twitchUser = process.env.TWITCH_BOT_USERNAME;
    const twitchToken = process.env.TWITCH_OAUTH_TOKEN;
    const twitchChannel = process.env.TWITCH_CHANNEL;
    if (twitchUser && twitchToken && twitchChannel) {
      try {
        const twitch = new TwitchChannel({
          username: twitchUser,
          token: twitchToken,
          channel: twitchChannel,
          prefix: process.env.TWITCH_COMMAND_PREFIX || "!ask",
        });
        this.channels.set("twitch", twitch);
        await twitch.start();
      } catch (e) {
        console.log(`[Channel:Twitch] Failed to start: ${e.message}`);
      }
    }

    // IRC
    const ircServer = process.env.IRC_SERVER;
    const ircNick = process.env.IRC_NICK;
    if (ircServer && ircNick) {
      try {
        const irc = new IRCChannel({
          server: ircServer,
          nick: ircNick,
          port: parseInt(process.env.IRC_PORT || "6667"),
          channel: process.env.IRC_CHANNEL,
          password: process.env.IRC_PASSWORD,
        });
        this.channels.set("irc", irc);
        await irc.start();
      } catch (e) {
        console.log(`[Channel:IRC] Failed to start: ${e.message}`);
      }
    }

    // iMessage (macOS only)
    if (process.platform === "darwin" && process.env.IMESSAGE_ENABLED === "true") {
      try {
        const imessage = new iMessageChannel({
          pollIntervalMs: parseInt(process.env.IMESSAGE_POLL_INTERVAL_MS || "5000"),
        });
        this.channels.set("imessage", imessage);
        await imessage.start();
      } catch (e) {
        console.log(`[Channel:iMessage] Failed to start: ${e.message}`);
      }
    }

    // Feishu / Lark
    const feishuAppId = process.env.FEISHU_APP_ID;
    const feishuSecret = process.env.FEISHU_APP_SECRET;
    if (feishuAppId && feishuSecret) {
      try {
        const feishu = new FeishuChannel({
          appId: feishuAppId,
          appSecret: feishuSecret,
          verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
          port: parseInt(process.env.FEISHU_PORT || "3004"),
        });
        this.channels.set("feishu", feishu);
        await feishu.start();
      } catch (e) {
        console.log(`[Channel:Feishu] Failed to start: ${e.message}`);
      }
    }

    // Zalo
    const zaloAppId = process.env.ZALO_APP_ID;
    const zaloToken = process.env.ZALO_ACCESS_TOKEN;
    if (zaloAppId && zaloToken) {
      try {
        const zalo = new ZaloChannel({
          appId: zaloAppId,
          appSecret: process.env.ZALO_APP_SECRET,
          accessToken: zaloToken,
          port: parseInt(process.env.ZALO_PORT || "3005"),
        });
        this.channels.set("zalo", zalo);
        await zalo.start();
      } catch (e) {
        console.log(`[Channel:Zalo] Failed to start: ${e.message}`);
      }
    }

    // Nextcloud Talk
    const nextcloudUrl = process.env.NEXTCLOUD_URL;
    const nextcloudUser = process.env.NEXTCLOUD_USER;
    const nextcloudPass = process.env.NEXTCLOUD_PASSWORD;
    if (nextcloudUrl && nextcloudUser && nextcloudPass) {
      try {
        const nextcloud = new NextcloudChannel({
          url: nextcloudUrl,
          user: nextcloudUser,
          password: nextcloudPass,
          roomToken: process.env.NEXTCLOUD_ROOM_TOKEN,
        });
        this.channels.set("nextcloud", nextcloud);
        await nextcloud.start();
      } catch (e) {
        console.log(`[Channel:Nextcloud] Failed to start: ${e.message}`);
      }
    }

    // BlueBubbles
    const bbUrl = process.env.BLUEBUBBLES_URL;
    const bbPassword = process.env.BLUEBUBBLES_PASSWORD;
    if (bbUrl && bbPassword) {
      try {
        const bb = new BlueBubblesChannel({ url: bbUrl, password: bbPassword });
        this.channels.set("bluebubbles", bb);
        await bb.start();
      } catch (e) {
        console.log(`[Channel:BlueBubbles] Failed to start: ${e.message}`);
      }
    }

    // Nostr
    const nostrKey = process.env.NOSTR_PRIVATE_KEY;
    if (nostrKey) {
      try {
        const relays = (process.env.NOSTR_RELAYS || "wss://relay.damus.io,wss://nos.lol").split(",").map(r => r.trim());
        const nostr = new NostrChannel({ privateKey: nostrKey, relays });
        this.channels.set("nostr", nostr);
        await nostr.start();
      } catch (e) {
        console.log(`[Channel:Nostr] Failed to start: ${e.message}`);
      }
    }

    const active = [...this.channels.entries()]
      .filter(([_, ch]) => ch.running)
      .map(([name]) => name);
    console.log(`[ChannelRegistry] Active channels: ${active.join(", ") || "none"}`);

    // Load per-tenant channel instances
    await this.loadTenantChannels();

    // Recovery reply handler — routes to the right instance via instanceKey
    eventBus.on("task:reply:needed", async ({ task }) => {
      const channel = this.get(task.channel, task.channelMeta?.instanceKey);
      if (!channel?.running) {
        console.log(`[ChannelRegistry] Cannot send recovered reply \u2014 channel "${task.channel}" not running`);
        return;
      }
      try {
        const reply = task.result || "(Task completed \u2014 no output)";
        await channel.sendReply(task.channelMeta, reply);
        console.log(`[ChannelRegistry] Recovered reply sent via ${task.channel} for task ${task.id}`);
      } catch (e) {
        console.log(`[ChannelRegistry] Failed to send recovered reply for task ${task.id}: ${e.message}`);
      }
    });
  }

  /**
   * Stop all channels.
   */
  async stopAll() {
    for (const [name, channel] of this.channels) {
      try {
        await channel.stop();
      } catch (error) {
        console.log(`[ChannelRegistry] Error stopping ${name}: ${error.message}`);
      }
    }
    console.log(`[ChannelRegistry] All channels stopped`);
  }

  /**
   * Get a channel instance.
   * If instanceKey is provided (per-tenant routing), tries that first.
   * Falls back to the global instance for the channel type.
   * @param {string} channelType - e.g. "discord"
   * @param {string} [instanceKey] - e.g. "discord::telegram:123456" (from channelMeta)
   */
  get(channelType, instanceKey) {
    if (instanceKey && instanceKey !== channelType) {
      const tenantInstance = this.channels.get(instanceKey);
      if (tenantInstance) return tenantInstance;
    }
    return this.channels.get(channelType);
  }

  /**
   * List all channels with status, including per-tenant instances.
   */
  list() {
    return [...this.channels.entries()].map(([key, ch]) => ({
      name: key,
      running: ch.running,
      tenantId: ch.getTenantId?.() || null,
    }));
  }

  /**
   * Returns all supported channel names (including unconfigured ones).
   */
  static getSupportedChannels() {
    return CHANNEL_DEFS.map(ch => ({
      name: ch.name,
      env: ch.envRequired.map(e => e.split("=")[0]).join(" + "),
      desc: ch.desc,
    }));
  }
}

const channelRegistry = new ChannelRegistry();
export default channelRegistry;
export { ChannelRegistry };
