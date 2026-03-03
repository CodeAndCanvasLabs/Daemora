import { BaseChannel } from "./BaseChannel.js";
import taskQueue from "../core/TaskQueue.js";
import { transcribeAudio } from "../tools/transcribeAudio.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";

/**
 * Telegram Channel - receives messages via Telegram Bot API (grammy).
 *
 * Handles:
 *   ✅ Text messages
 *   ✅ Voice messages   → transcribed with Whisper → processed as text task
 *   ✅ Photos           → downloaded to /tmp → agent can imageAnalysis the path
 *   ✅ Videos           → downloaded to /tmp → included as context
 *   ✅ Documents/files  → downloaded to /tmp → included as context
 *   ✅ Audio files      → transcribed like voice messages
 *
 * Agent can send back:
 *   ✅ Text replies
 *   ✅ Photos (jpg/png/gif/webp)
 *   ✅ Videos (mp4/mov/avi)
 *   ✅ Documents (any other file)
 *
 * Config:
 *   token     - Bot token from @BotFather
 *   allowlist - Optional array of chat IDs allowed to send tasks. Empty = open.
 *   model     - Optional model override
 */
export class TelegramChannel extends BaseChannel {
  constructor(config) {
    super("telegram", config);
    this.bot = null;
  }

  async start() {
    const { Bot, InputFile } = await import("grammy");
    this._InputFile = InputFile;

    if (!this.config.token) {
      console.log(`[Channel:Telegram] Skipped - no TELEGRAM_BOT_TOKEN`);
      return;
    }

    this.bot = new Bot(this.config.token);

    console.log(`[Channel:Telegram] Connecting to Telegram API...`);
    const me = await Promise.race([
      this.bot.api.getMe(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Connection timed out after 10s")), 10000)),
    ]);
    console.log(`[Channel:Telegram] Verified bot: @${me.username}`);

    // ── Text messages ────────────────────────────────────────────────────────
    this.bot.on("message:text", async (ctx) => {
      const chatId   = ctx.chat.id.toString();
      const text     = ctx.message.text;
      const userName = ctx.from?.first_name || "User";

      if (!this.isAllowed(chatId)) {
        await ctx.reply("You are not authorized to use this agent.");
        return;
      }

      console.log(`[Channel:Telegram] Text from ${userName} (${chatId}): "${text.slice(0, 80)}"`);
      await ctx.replyWithChatAction("typing");
      await this.sendReaction({ chatId, messageId: ctx.message.message_id }, "⏳");
      await this._processTask(ctx, chatId, text);
    });

    // ── Voice messages ───────────────────────────────────────────────────────
    this.bot.on("message:voice", async (ctx) => {
      const chatId   = ctx.chat.id.toString();
      const userName = ctx.from?.first_name || "User";

      if (!this.isAllowed(chatId)) {
        await ctx.reply("You are not authorized to use this agent.");
        return;
      }

      console.log(`[Channel:Telegram] Voice from ${userName} (${chatId}) - transcribing...`);
      await ctx.replyWithChatAction("typing");
      await this.sendReaction({ chatId, messageId: ctx.message.message_id }, "⏳");

      const audioPath = await this._downloadFile(ctx.message.voice.file_id, ".ogg");
      if (!audioPath) {
        await ctx.reply("Sorry, I couldn't download your voice message.");
        return;
      }

      const transcript = await transcribeAudio(audioPath);
      if (transcript.startsWith("Error:")) {
        // Fall back: let user know STT isn't configured
        await ctx.reply(`I received your voice message but couldn't transcribe it: ${transcript}\n\nPlease type your request instead.`);
        return;
      }

      console.log(`[Channel:Telegram] Voice transcript: "${transcript.slice(0, 80)}"`);
      await this._processTask(ctx, chatId, `[Voice message]: ${transcript}`);
    });

    // ── Audio files ──────────────────────────────────────────────────────────
    this.bot.on("message:audio", async (ctx) => {
      const chatId = ctx.chat.id.toString();
      if (!this.isAllowed(chatId)) { await ctx.reply("Not authorized."); return; }

      await ctx.replyWithChatAction("typing");
      await this.sendReaction({ chatId, messageId: ctx.message.message_id }, "⏳");

      const audio    = ctx.message.audio;
      const ext      = extname(audio.file_name || ".mp3") || ".mp3";
      const audioPath = await this._downloadFile(audio.file_id, ext);
      if (!audioPath) { await ctx.reply("Couldn't download audio file."); return; }

      const transcript = await transcribeAudio(audioPath);
      const input = transcript.startsWith("Error:")
        ? `[Audio file received: ${audioPath}]\n${transcript}`
        : `[Audio transcript]: ${transcript}`;

      await this._processTask(ctx, chatId, input);
    });

    // ── Photos ───────────────────────────────────────────────────────────────
    this.bot.on("message:photo", async (ctx) => {
      const chatId   = ctx.chat.id.toString();
      const userName = ctx.from?.first_name || "User";

      if (!this.isAllowed(chatId)) {
        await ctx.reply("You are not authorized to use this agent.");
        return;
      }

      console.log(`[Channel:Telegram] Photo from ${userName} (${chatId})`);
      await ctx.replyWithChatAction("typing");
      await this.sendReaction({ chatId, messageId: ctx.message.message_id }, "⏳");

      // Take the highest-resolution version (last in array)
      const photos   = ctx.message.photo;
      const best     = photos[photos.length - 1];
      const imgPath  = await this._downloadFile(best.file_id, ".jpg");

      if (!imgPath) {
        await ctx.reply("Sorry, I couldn't download your photo.");
        return;
      }

      const caption = ctx.message.caption?.trim() || "";
      const input   = caption
        ? `[Photo received: ${imgPath}]\nUser caption: ${caption}`
        : `[Photo received: ${imgPath}]\nDescribe this image and respond to it.`;

      await this._processTask(ctx, chatId, input);
    });

    // ── Videos ───────────────────────────────────────────────────────────────
    this.bot.on("message:video", async (ctx) => {
      const chatId = ctx.chat.id.toString();
      if (!this.isAllowed(chatId)) { await ctx.reply("Not authorized."); return; }

      await ctx.replyWithChatAction("upload_video");
      await this.sendReaction({ chatId, messageId: ctx.message.message_id }, "⏳");

      const videoPath = await this._downloadFile(ctx.message.video.file_id, ".mp4");
      const caption   = ctx.message.caption?.trim() || "";
      const input     = videoPath
        ? `[Video received: ${videoPath}]\n${caption || "User sent a video."}`
        : `[User sent a video but download failed]\n${caption || ""}`;

      await this._processTask(ctx, chatId, input);
    });

    // ── Documents / files ────────────────────────────────────────────────────
    this.bot.on("message:document", async (ctx) => {
      const chatId = ctx.chat.id.toString();
      if (!this.isAllowed(chatId)) { await ctx.reply("Not authorized."); return; }

      await ctx.replyWithChatAction("typing");
      await this.sendReaction({ chatId, messageId: ctx.message.message_id }, "⏳");

      const doc      = ctx.message.document;
      const ext      = extname(doc.file_name || "") || "";
      const filePath = await this._downloadFile(doc.file_id, ext);
      const caption  = ctx.message.caption?.trim() || "";

      const input = filePath
        ? `[File received: ${filePath} (${doc.file_name || "document"}, ${_fmtSize(doc.file_size)})]\n${caption || "User sent a file."}`
        : `[User sent a file "${doc.file_name}" but download failed]\n${caption || ""}`;

      await this._processTask(ctx, chatId, input);
    });

    // Start long polling in background
    this.bot.start().catch((err) => {
      console.log(`[Channel:Telegram] Polling error: ${err.message}`);
      this.running = false;
    });

    this.running = true;
    console.log(`[Channel:Telegram] Started as @${me.username}`);
    if (this.config.allowlist?.length) {
      console.log(`[Channel:Telegram] Allowlist active - ${this.config.allowlist.length} authorized chat(s)`);
    }
  }

  // ── Shared task processor ──────────────────────────────────────────────────
  async _processTask(ctx, chatId, input) {
    const messageId = ctx.message.message_id;
    const userName  = ctx.from?.first_name || "User";

    const task = taskQueue.enqueue({
      input,
      channel:     "telegram",
      channelMeta: { chatId, userName, messageId, channel: "telegram" },
      sessionId:   this.getSessionId(chatId),
      model:       this.getModel(),
    });

    try {
      const completedTask = await taskQueue.waitForCompletion(task.id);

      // Task was absorbed into a concurrent agent session - response already sent
      if (this.isTaskMerged(completedTask)) {
        await this.sendReaction({ chatId, messageId }, "✅");
        return;
      }

      const failed  = completedTask.status === "failed";
      const response = failed
        ? `Sorry, I encountered an error: ${completedTask.error}`
        : completedTask.result || "Done.";

      await this.sendReaction({ chatId, messageId }, failed ? "❌" : "✅");

      const chunks = splitMessage(response, 4096);
      for (const chunk of chunks) {
        await ctx.reply(chunk).catch(() => {});
      }
    } catch (error) {
      console.error(`[Channel:Telegram] Error:`, error.message);
      await this.sendReaction({ chatId, messageId }, "❌");
      await ctx.reply("Sorry, something went wrong. Please try again.").catch(() => {});
    }
  }

  // ── Download a Telegram file to /tmp ──────────────────────────────────────
  async _downloadFile(fileId, extension) {
    try {
      const file    = await this.bot.api.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`;

      const res = await fetch(fileUrl, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) return null;

      const buffer   = await res.arrayBuffer();
      const tmpDir   = join(tmpdir(), "daemora-tg");
      mkdirSync(tmpDir, { recursive: true });
      const filePath = join(tmpDir, `${fileId}${extension}`);
      writeFileSync(filePath, Buffer.from(buffer));

      return filePath;
    } catch (err) {
      console.log(`[Channel:Telegram] File download error: ${err.message}`);
      return null;
    }
  }

  async stop() {
    if (this.bot) {
      await this.bot.stop();
      this.running = false;
      console.log(`[Channel:Telegram] Stopped`);
    }
  }

  async sendReply(channelMeta, text) {
    if (!this.bot) return;
    const chunks = splitMessage(text, 4096);
    for (const chunk of chunks) {
      await this.bot.api.sendMessage(channelMeta.chatId, chunk).catch(() => {});
    }
  }

  /**
   * Send a local file to a Telegram chat.
   * Auto-detects type: image → sendPhoto, video → sendVideo, other → sendDocument.
   */
  async sendFile(channelMeta, filePath, caption) {
    if (!this.bot || !this._InputFile) return;
    const chatId = channelMeta.chatId;
    if (!chatId) return;

    const ext = extname(filePath).toLowerCase();
    const imgExts   = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
    const videoExts = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);

    const opts = caption ? { caption } : {};

    try {
      if (imgExts.has(ext)) {
        await this.bot.api.sendPhoto(chatId, new this._InputFile(filePath), opts);
      } else if (videoExts.has(ext)) {
        await this.bot.api.sendVideo(chatId, new this._InputFile(filePath), opts);
      } else {
        await this.bot.api.sendDocument(chatId, new this._InputFile(filePath), opts);
      }
    } catch (err) {
      console.log(`[Channel:Telegram] sendFile error: ${err.message}`);
    }
  }

  /**
   * Set a native Telegram emoji reaction on a message.
   * Uses setMessageReaction (Bot API 7.0+). Silent failure if not supported.
   */
  async sendReaction(channelMeta, emoji) {
    if (!this.bot || !channelMeta.messageId) return;
    try {
      await this.bot.api.setMessageReaction(
        channelMeta.chatId,
        channelMeta.messageId,
        [{ type: "emoji", emoji }]
      );
    } catch (_) {}
  }
}

function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) { chunks.push(remaining); break; }
    let idx = remaining.lastIndexOf("\n", maxLength);
    if (idx === -1 || idx < maxLength * 0.5) idx = remaining.lastIndexOf(" ", maxLength);
    if (idx === -1) idx = maxLength;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }
  return chunks;
}

function _fmtSize(bytes) {
  if (!bytes) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
