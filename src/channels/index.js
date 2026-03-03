// HTTP channel is intentionally commented out - it has no authentication.
// Anyone on the network could send arbitrary tasks to the agent.
// Uncomment only if you've added your own auth middleware.
// import { HttpChannel } from "./HttpChannel.js";

import { TelegramChannel } from "./TelegramChannel.js";
import { WhatsAppChannel } from "./WhatsAppChannel.js";
import { EmailChannel } from "./EmailChannel.js";
import { DiscordChannel } from "./DiscordChannel.js";
import { SlackChannel } from "./SlackChannel.js";
import { LineChannel } from "./LineChannel.js";
import { SignalChannel } from "./SignalChannel.js";
import { TeamsChannel } from "./TeamsChannel.js";
import { GoogleChatChannel } from "./GoogleChatChannel.js";
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

    // Telegram - check process.env directly (vault may have loaded token after config init)
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

    // WhatsApp - check process.env directly
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

    // Email - check process.env directly
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

    // Discord - check process.env directly
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

    // Slack - requires both bot token and app token (Socket Mode)
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

    // LINE - webhook-based, needs access token + channel secret
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

    // Signal - requires signal-cli running as REST daemon
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

    // Microsoft Teams - Bot Framework v4
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

    // Google Chat - service account + Chat API webhook
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

    const active = [...this.channels.entries()]
      .filter(([_, ch]) => ch.running)
      .map(([name]) => name);
    console.log(`[ChannelRegistry] Active channels: ${active.join(", ") || "none"}`);

    // Recovery reply handler — when a task completes after an agent restart and there
    // is no channel waiter (because the original process died), route the reply back
    // to the user automatically via the channel's existing sendReply() method.
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
}

const channelRegistry = new ChannelRegistry();
export default channelRegistry;
