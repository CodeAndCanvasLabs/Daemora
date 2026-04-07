import { BaseChannel } from "./BaseChannel.js";
import taskQueue from "../core/TaskQueue.js";
import eventBus from "../core/EventBus.js";
import { transcribeAudio } from "../tools/transcribeAudio.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { getTenantTmpDir } from "../tools/_paths.js";

/**
 * Discord Channel - receives messages via Discord Bot API.
 *
 * Setup:
 * 1. Go to https://discord.com/developers/applications
 * 2. Create a new application → Bot → copy the token
 * 3. Enable "Message Content Intent" under Bot → Privileged Gateway Intents
 * 4. Invite bot to your server with permissions: Send Messages, Read Message History, Add Reactions
 * 5. Set env: DISCORD_BOT_TOKEN
 *
 * Config:
 *   token     - Bot token
 *   allowlist - Optional array of Discord user IDs (snowflakes) allowed to use the bot
 *   model     - Optional model override
 *
 * The bot responds to:
 *   - Direct messages (DMs)
 *   - Messages that @mention the bot in any channel
 */
export class DiscordChannel extends BaseChannel {
  constructor(config) {
    super("discord", config);
    this.client = null;
    this.botUserId = null;
  }

  async start() {
    if (!this.config.token) {
      console.log(`[Channel:Discord] Skipped - no DISCORD_BOT_TOKEN`);
      return;
    }

    const { Client, GatewayIntentBits, Partials } = await import("discord.js");

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageTyping,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });

    this._readyPromise = new Promise(resolve => {
      this.client.once("ready", async (c) => {
        this.botUserId = c.user.id;
        this.running = true;
        console.log(`[Channel:Discord] Logged in as ${c.user.tag}`);
        if (this.config.allowlist?.length) {
          console.log(`[Channel:Discord] Allowlist active - ${this.config.allowlist.length} authorized user(s)`);
        }
        resolve();

        // Catch up on messages missed while offline
        try { await this._catchUpMissedMessages(); } catch (e) {
          console.log(`[Channel:Discord] Catch-up failed (non-fatal): ${e.message}`);
        }
      });
    });

    this.client.on("messageCreate", async (message) => {
      // Ignore messages from bots (including self)
      if (message.author.bot) return;

      const isDM = message.channel.type === 1; // DM_CHANNEL = 1
      // Only direct @user mentions — ignore role mentions (@&roleId), @everyone, @here
      const isMention = this.botUserId && message.mentions.users.has(this.botUserId);

      // Only respond to DMs or direct @bot mentions
      if (!isDM && !isMention) return;

      const userId = message.author.id;

      // Allowlist check
      if (!this.isAllowed(userId)) {
        console.log(`[Channel:Discord] Blocked (not in allowlist): ${userId}`);
        await message.reply("You are not authorized to use this agent.").catch(() => {});
        return;
      }

      // Strip user mentions (@user) and role mentions (@&role) from content
      const text = message.content
        .replace(/<@[!&]?\d+>/g, "")
        .trim();

      const hasAttachments = message.attachments.size > 0;

      if (!text && !hasAttachments) {
        await message.reply("Send me a message and I'll get to work.").catch(() => {});
        return;
      }

      const channelId = message.channelId;

      console.log(`[Channel:Discord] Message from ${message.author.username} (${userId}): "${text.slice(0, 80)}"${hasAttachments ? ` + ${message.attachments.size} attachment(s)` : ""}`);

      // Show typing indicator while processing
      try { await message.channel.sendTyping(); } catch (_) {}

      // React ⏳ to show we received it
      await this.sendReaction({ message }, "⏳");

      // Build task input: text + any attachments
      const inputParts = text ? [text] : [];
      for (const [, attachment] of message.attachments) {
        const localPath = await this._downloadAttachment(attachment);
        if (!localPath) continue;

        const ct = attachment.contentType || "";
        if (ct.startsWith("audio/")) {
          console.log(`[Channel:Discord] Audio attachment - transcribing...`);
          const transcript = await transcribeAudio(localPath);
          inputParts.push(transcript.startsWith("Error:")
            ? `[Audio file: ${localPath}]\n${transcript}`
            : `[Audio transcript]: ${transcript}`);
        } else if (ct.startsWith("image/")) {
          inputParts.push(`[Photo received: ${localPath}]\nUser caption: ${attachment.description || text || "Describe and respond to this image."}`);
        } else if (ct.startsWith("video/")) {
          inputParts.push(`[Video received: ${localPath}]`);
        } else {
          inputParts.push(`[File received: ${localPath} (${attachment.name || "document"}, ${_fmtSize(attachment.size)})]`);
        }
      }

      const input = inputParts.join("\n");

      // Enqueue task
      const task = taskQueue.enqueue({
        input,
        channel: "discord",
        channelMeta: { userId, userName: message.author.username, channelId, messageId: message.id, guildId: message.guildId, channel: "discord" },
        sessionId: this.getSessionId(userId),
        model: this.getModel(),
      });

      try {
        const completedTask = await taskQueue.waitForCompletion(task.id);

        // Absorbed into a concurrent session - response already sent via original task
        if (this.isTaskMerged(completedTask)) {
          await this._removeReaction(message, "⏳");
          await this.sendReaction({ message }, "✅");
          return;
        }

        const failed = completedTask.status === "failed";
        const response = failed
          ? `Sorry, I encountered an error: ${completedTask.error}`
          : completedTask.result || "Done.";

        // Remove ⏳ and add ✅ or ❌
        await this._removeReaction(message, "⏳");
        await this.sendReaction({ message }, failed ? "❌" : "✅");

        // Discord message limit: 2000 chars
        const chunks = splitMessage(response, 1990);
        await message.reply(chunks[0]).catch(() => {});
        for (let i = 1; i < chunks.length; i++) {
          await message.channel.send(chunks[i]).catch(() => {});
        }
      } catch (error) {
        console.error(`[Channel:Discord] Error:`, error.message);
        await this._removeReaction(message, "⏳");
        await this.sendReaction({ message }, "❌");
        try { await message.reply("Sorry, something went wrong. Please try again."); } catch (_) {}
      }
    });

    // Listen for approval requests
    eventBus.on("approval:request", async (data) => {
      if (data.channelMeta?.channel !== "discord") return;
      const channel = await this.client.channels.fetch(data.channelMeta?.channelId).catch(() => null);
      if (channel) await channel.send(data.message).catch(() => {});
    });

    try {
      await this.client.login(this.config.token);
      // Wait for 'ready' so this.running=true before start() returns.
      // Without this, startTenantChannel sees running=false and never registers the instance.
      await Promise.race([
        this._readyPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error("Discord ready timeout (30s)")), 30000)),
      ]);
    } catch (err) {
      console.log(`[Channel:Discord] Login failed: ${err.message}`);
      this.running = false;
    }
  }

  async stop() {
    try {
      const { configStore } = await import("../config/ConfigStore.js");
      configStore.set("DISCORD_LAST_SEEN", new Date().toISOString());
    } catch {}
    if (this.client) {
      await this.client.destroy();
      this.running = false;
      console.log(`[Channel:Discord] Stopped`);
    }
  }

  /**
   * Catch up on DMs missed while the bot was offline.
   * Fetches recent messages after DISCORD_LAST_SEEN timestamp.
   */
  async _catchUpMissedMessages() {
    const { configStore } = await import("../config/ConfigStore.js");
    const lastSeen = configStore.get("DISCORD_LAST_SEEN");
    if (!lastSeen) return;

    const cutoff = new Date(lastSeen);
    const now = new Date();
    const offlineMs = now - cutoff;

    if (offlineMs > 86400000) {
      console.log(`[Channel:Discord] Offline > 24h — skipping catch-up`);
      configStore.set("DISCORD_LAST_SEEN", now.toISOString());
      return;
    }

    console.log(`[Channel:Discord] Catching up on messages since ${lastSeen} (${Math.round(offlineMs / 60000)}min offline)`);
    let caught = 0;

    try {
      const dmChannels = this.client.channels.cache.filter(c => c.type === 1);
      for (const [, channel] of dmChannels) {
        try {
          const DISCORD_EPOCH = 1420070400000n;
          const afterSnowflake = ((BigInt(cutoff.getTime()) - DISCORD_EPOCH) << 22n).toString();
          const messages = await channel.messages.fetch({ limit: 20, after: afterSnowflake });
          for (const [, msg] of messages) {
            if (msg.author.bot) continue;
            if (!this.isAllowed(msg.author.id)) continue;
            const text = msg.content?.replace(/<@!?\d+>/g, "").trim();
            if (!text && msg.attachments.size === 0) continue;
            console.log(`[Channel:Discord] Catch-up: "${text?.slice(0, 60)}" from ${msg.author.username}`);
            this.client.emit("messageCreate", msg);
            caught++;
          }
        } catch {}
      }
    } catch {}

    configStore.set("DISCORD_LAST_SEEN", now.toISOString());
    if (caught > 0) console.log(`[Channel:Discord] Caught up ${caught} missed message(s)`);
    else console.log(`[Channel:Discord] No missed messages`);
  }

  async sendReply(channelMeta, text) {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(channelMeta.channelId);
      const chunks = splitMessage(text, 1990);
      for (const chunk of chunks) {
        await channel.send(chunk);
      }
    } catch (err) {
      console.log(`[Channel:Discord] sendReply error: ${err.message}`);
    }
  }

  async sendEmbed(channelMeta, embed) {
    if (!this.client) return;
    try {
      const { EmbedBuilder } = await import("discord.js");
      const channel = await this.client.channels.fetch(channelMeta.channelId);
      const eb = new EmbedBuilder();
      if (embed.title) eb.setTitle(embed.title);
      if (embed.description) eb.setDescription(embed.description);
      if (embed.color) eb.setColor(embed.color);
      if (embed.fields?.length > 0) eb.addFields(embed.fields);
      if (embed.imageUrl) eb.setImage(embed.imageUrl);
      if (embed.footerText) eb.setFooter({ text: embed.footerText });
      await channel.send({ embeds: [eb] });
    } catch (err) { console.log(`[Channel:Discord] sendEmbed error: ${err.message}`); }
  }

  async editMessage(channelMeta, messageId, newText) {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(channelMeta.channelId);
      const msg = await channel.messages.fetch(messageId);
      if (msg) await msg.edit(newText);
    } catch (err) { console.log(`[Channel:Discord] editMessage error: ${err.message}`); }
  }

  async deleteMessage(channelMeta, messageId) {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(channelMeta.channelId);
      const msg = await channel.messages.fetch(messageId);
      if (msg) await msg.delete();
    } catch (err) { console.log(`[Channel:Discord] deleteMessage error: ${err.message}`); }
  }

  async sendThreadReply(channelMeta, text) {
    if (!this.client) return;
    try {
      const msg = channelMeta?.message;
      if (msg) await msg.reply(text);
      else await this.sendReply(channelMeta, text);
    } catch (err) { await this.sendReply(channelMeta, text); }
  }

  async sendTyping(channelMeta) {
    try {
      const msg = channelMeta?.message;
      if (msg?.channel) await msg.channel.sendTyping();
      else if (channelMeta?.channelId) {
        const ch = await this.client.channels.fetch(channelMeta.channelId);
        if (ch) await ch.sendTyping();
      }
    } catch (_) {}
  }

  async sendReaction(channelMeta, emoji) {
    const msg = channelMeta?.message;
    if (!msg) return;
    try {
      await msg.react(emoji);
    } catch (_) {}
  }

  /** Remove a specific reaction emoji the bot added. */
  async _removeReaction(message, emoji) {
    try {
      const reaction = message.reactions.cache.get(emoji);
      if (reaction) await reaction.users.remove(this.client.user.id);
    } catch (_) {}
  }

  /**
   * Send a local file to a Discord channel.
   */
  async sendFile(channelMeta, filePath, caption) {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(channelMeta.channelId);
      await channel.send({
        content: caption || undefined,
        files: [{ attachment: filePath, name: basename(filePath) }],
      });
    } catch (err) {
      console.log(`[Channel:Discord] sendFile error: ${err.message}`);
    }
  }

  /**
   * Download a Discord attachment to /tmp and return the local path.
   */
  async _downloadAttachment(attachment) {
    try {
      const ext = extname(attachment.name || attachment.url || "").split("?")[0] || "";
      const tmpDir = getTenantTmpDir("discord");
      mkdirSync(tmpDir, { recursive: true });
      const filePath = join(tmpDir, `${attachment.id}${ext}`);

      const res = await fetch(attachment.url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) return null;

      const buffer = await res.arrayBuffer();
      writeFileSync(filePath, Buffer.from(buffer));
      return filePath;
    } catch (err) {
      console.log(`[Channel:Discord] Attachment download error: ${err.message}`);
      return null;
    }
  }
}

function _fmtSize(bytes) {
  if (!bytes) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) { chunks.push(remaining); break; }
    let idx = remaining.lastIndexOf("\n", maxLength);
    if (idx < maxLength * 0.5) idx = remaining.lastIndexOf(" ", maxLength);
    if (idx === -1) idx = maxLength;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }
  return chunks;
}
