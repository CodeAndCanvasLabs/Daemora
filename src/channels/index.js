// HTTP channel is intentionally commented out - it has no authentication.
// Anyone on the network could send arbitrary tasks to the agent.
// Uncomment only if you've added your own auth middleware.
// import { HttpChannel } from "./HttpChannel.js";

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

/**
 * Channel Registry - manages all input channels.
 * Each channel auto-starts if its credentials are configured.
 */
class ChannelRegistry {
  constructor() {
    this.channels = new Map();
  }

  /**
   * Initialize and start all enabled channels.
   */
  async startAll() {
    // ─── HTTP channel disabled (no authentication) ────────────────────────────
    // const http = new HttpChannel(config.channels.http);
    // this.channels.set("http", http);
    // await http.start();
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

    // Recovery reply handler
    eventBus.on("task:reply:needed", async ({ task }) => {
      const channel = this.channels.get(task.channel);
      if (!channel?.running) {
        console.log(`[ChannelRegistry] Cannot send recovered reply — channel "${task.channel}" not running`);
        return;
      }
      try {
        const reply = task.result || "(Task completed — no output)";
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
   * Get a channel by name.
   */
  get(name) {
    return this.channels.get(name);
  }

  /**
   * List all channels with status.
   */
  list() {
    return [...this.channels.entries()].map(([name, ch]) => ({
      name,
      running: ch.running,
    }));
  }

  /**
   * Returns all supported channel names (including unconfigured ones).
   */
  static getSupportedChannels() {
    return [
      { name: "telegram",    env: "TELEGRAM_BOT_TOKEN",                         desc: "Telegram bot" },
      { name: "whatsapp",    env: "TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN",     desc: "WhatsApp via Twilio" },
      { name: "discord",     env: "DISCORD_BOT_TOKEN",                          desc: "Discord bot" },
      { name: "slack",       env: "SLACK_BOT_TOKEN + SLACK_APP_TOKEN",          desc: "Slack Socket Mode bot" },
      { name: "email",       env: "EMAIL_USER + EMAIL_PASSWORD",                desc: "Email (IMAP/SMTP)" },
      { name: "line",        env: "LINE_CHANNEL_ACCESS_TOKEN + LINE_CHANNEL_SECRET", desc: "LINE messaging" },
      { name: "signal",      env: "SIGNAL_CLI_URL + SIGNAL_PHONE_NUMBER",       desc: "Signal via signal-cli" },
      { name: "teams",       env: "TEAMS_APP_ID + TEAMS_APP_PASSWORD",          desc: "Microsoft Teams Bot Framework" },
      { name: "googlechat",  env: "GOOGLE_CHAT_SERVICE_ACCOUNT",                desc: "Google Chat service account" },
      { name: "matrix",      env: "MATRIX_HOMESERVER_URL + MATRIX_ACCESS_TOKEN", desc: "Matrix (Element) protocol" },
      { name: "mattermost",  env: "MATTERMOST_URL + MATTERMOST_TOKEN",          desc: "Mattermost WebSocket bot" },
      { name: "twitch",      env: "TWITCH_BOT_USERNAME + TWITCH_OAUTH_TOKEN + TWITCH_CHANNEL", desc: "Twitch chat commands" },
      { name: "irc",         env: "IRC_SERVER + IRC_NICK",                      desc: "IRC (any server)" },
      { name: "imessage",    env: "IMESSAGE_ENABLED=true (macOS only)",         desc: "iMessage via AppleScript" },
      { name: "feishu",      env: "FEISHU_APP_ID + FEISHU_APP_SECRET",          desc: "Feishu / Lark" },
      { name: "zalo",        env: "ZALO_APP_ID + ZALO_ACCESS_TOKEN",            desc: "Zalo (Vietnam)" },
      { name: "nextcloud",   env: "NEXTCLOUD_URL + NEXTCLOUD_USER + NEXTCLOUD_PASSWORD", desc: "Nextcloud Talk" },
      { name: "bluebubbles", env: "BLUEBUBBLES_URL + BLUEBUBBLES_PASSWORD",     desc: "BlueBubbles iMessage relay" },
      { name: "nostr",       env: "NOSTR_PRIVATE_KEY",                          desc: "Nostr decentralized protocol" },
    ];
  }
}

const channelRegistry = new ChannelRegistry();
export default channelRegistry;
export { ChannelRegistry };
