/**
 * TelegramChannel — Telegram Bot API integration.
 *
 * Uses raw fetch against the Bot API — no external packages.
 * Supports both long-polling (getUpdates) and webhook modes.
 * Handles text, voice, audio, photo, video, and document updates. Voice
 * and audio are downloaded and transcribed via Whisper so the agent
 * receives usable text; media files are saved to a temp dir and their
 * paths are embedded so the agent can read / analyse them with its
 * normal tools.
 */

import { createWriteStream, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { ConfigManager } from "../config/ConfigManager.js";
import { createLogger } from "../util/logger.js";
import { transcribeAudioFile } from "../voice/transcribe.js";
import { BaseChannel, type ChannelMeta, type IncomingMessage, type InboundAttachment } from "./BaseChannel.js";

const log = createLogger("channel.telegram");

const API_BASE = "https://api.telegram.org/bot";

// ── Types ─────────────────────────────────────────────────────────

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name: string; username?: string };
  chat: { id: number; type: string };
  date: number;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; width: number; height: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id: string; duration: number; mime_type?: string };
  audio?: { file_id: string; duration: number; file_name?: string; mime_type?: string };
  video?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  video_note?: { file_id: string; duration: number };
}

export interface TelegramChannelOpts {
  /** Bot token from @BotFather. */
  token: string;
  /** Callback when an incoming message is received. */
  onMessage: (msg: IncomingMessage) => void;
  /** Optional: webhook URL. If omitted, uses long polling. */
  webhookUrl?: string;
  /** Optional: allowed user IDs. Empty = allow all. */
  allowedUsers?: readonly string[];
  /** Optional: polling interval in ms (default 1000). */
  pollInterval?: number;
  /** Config manager — needed to reach the vault for STT API keys. */
  cfg: ConfigManager;
}

// ── Markdown escaping ─────────────────────────────────────────────

const MD_V2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

function escapeMarkdownV2(text: string): string {
  return text.replace(MD_V2_SPECIAL, "\\$&");
}

/**
 * Light formatting for Telegram MarkdownV2.
 * Escapes special chars but preserves simple bold/italic/code blocks
 * that are already correctly formed.
 */
function formatForTelegram(text: string): string {
  // If text has no markdown, just escape it
  if (!/[*_`]/.test(text)) return escapeMarkdownV2(text);

  // Preserve code blocks, escape the rest
  const parts: string[] = [];
  let remaining = text;

  // Handle triple-backtick code blocks
  const codeBlockRe = /```([\s\S]*?)```/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRe.exec(remaining)) !== null) {
    const before = remaining.slice(lastIdx, match.index);
    parts.push(escapeMarkdownV2(before));
    parts.push("```" + match[1] + "```");
    lastIdx = match.index + match[0].length;
  }
  parts.push(escapeMarkdownV2(remaining.slice(lastIdx)));

  return parts.join("");
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── Channel implementation ────────────────────────────────────────

export class TelegramChannel extends BaseChannel {
  readonly id = "telegram" as const;
  readonly name = "Telegram" as const;
  override readonly supportsStreaming = true;
  override readonly supportsFiles = true;
  override readonly maxMessageLength = 4090;

  private readonly token: string;
  private readonly onMessage: (msg: IncomingMessage) => void;
  private readonly webhookUrl: string | undefined;
  private readonly allowedUsers: ReadonlySet<string>;
  private readonly pollInterval: number;
  private readonly cfg: ConfigManager;

  private offset = 0;
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private downloadDir: string | null = null;

  constructor(opts: TelegramChannelOpts) {
    super();
    this.token = opts.token;
    this.onMessage = opts.onMessage;
    this.webhookUrl = opts.webhookUrl;
    this.allowedUsers = new Set(opts.allowedUsers ?? []);
    this.pollInterval = opts.pollInterval ?? 1000;
    this.cfg = opts.cfg;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.webhookUrl) {
      await this.setWebhook(this.webhookUrl);
      log.info({ webhookUrl: this.webhookUrl }, "telegram webhook set");
    } else {
      // Clear any existing webhook before long-polling.
      await this.apiCall("deleteWebhook", { drop_pending_updates: false })
        .catch(() => { /* best-effort */ });
      // Tell Telegram to drop any in-flight long-poll from a previous
      // process (tsx watch / SIGKILL restarts leave getUpdates hanging
      // on Telegram's side up to 60s, and the new poll gets 409 until
      // it times out). `close` returns an error if there's no live
      // session — swallow it.
      await this.apiCall("close").catch(() => { /* best-effort */ });
      this.polling = true;
      this.poll();
      log.info("telegram long-polling started");
    }
  }

  async stop(): Promise<void> {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    log.info("telegram channel stopped");
  }

  // ── Outbound ──────────────────────────────────────────────────

  override async sendReply(meta: ChannelMeta, text: string): Promise<void> {
    const chatId = meta.chatId ?? meta.userId;
    const formatted = formatForTelegram(text);

    await this.apiCall("sendMessage", {
      chat_id: chatId,
      text: formatted,
      parse_mode: "MarkdownV2",
      ...(meta.messageId ? { reply_to_message_id: Number(meta.messageId) } : {}),
    });
  }

  override async sendOrEditStream(
    meta: ChannelMeta,
    text: string,
    prevMessageId: string | null,
  ): Promise<string | null> {
    const chatId = meta.chatId ?? meta.userId;
    const formatted = formatForTelegram(text);

    if (prevMessageId) {
      await this.apiCall("editMessageText", {
        chat_id: chatId,
        message_id: Number(prevMessageId),
        text: formatted,
        parse_mode: "MarkdownV2",
      });
      return prevMessageId;
    }

    const resp = (await this.apiCall<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: formatted,
      parse_mode: "MarkdownV2",
      ...(meta.messageId ? { reply_to_message_id: Number(meta.messageId) } : {}),
    })) as { message_id: number } | null;
    return resp ? String(resp.message_id) : null;
  }

  override async sendTyping(meta: ChannelMeta): Promise<void> {
    const chatId = meta.chatId ?? meta.userId;
    await this.apiCall("sendChatAction", {
      chat_id: chatId,
      action: "typing",
    });
  }

  /**
   * Upload a local file to a Telegram chat. Routes to the best-fit
   * endpoint: photos → sendPhoto (renders inline), videos → sendVideo,
   * audio → sendAudio, everything else → sendDocument. Uses multipart
   * form so the raw bytes are uploaded — no need for a public URL.
   */
  override async sendFile(meta: ChannelMeta, path: string, caption?: string): Promise<void> {
    const chatId = meta.chatId ?? meta.userId;
    if (!chatId) return;
    try {
      const bytes = readFileSync(path);
      const name = basename(path);
      const ext = extname(path).toLowerCase();
      const { endpoint, fieldName } = telegramEndpointForExt(ext);
      const form = new FormData();
      form.append("chat_id", String(chatId));
      if (caption && caption.trim().length > 0) form.append("caption", caption);
      form.append(
        fieldName,
        new Blob([new Uint8Array(bytes)]),
        name,
      );
      const url = `${API_BASE}${this.token}/${endpoint}`;
      const resp = await fetch(url, { method: "POST", body: form });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        log.error({ endpoint, status: resp.status, body: body.slice(0, 300) }, "telegram sendFile failed");
      }
    } catch (err) {
      log.error({ err: (err as Error).message, path }, "telegram sendFile errored");
    }
  }

  override async editMessage(meta: ChannelMeta, messageId: string, text: string): Promise<void> {
    const chatId = meta.chatId ?? meta.userId;
    const formatted = formatForTelegram(text);

    await this.apiCall("editMessageText", {
      chat_id: chatId,
      message_id: Number(messageId),
      text: formatted,
      parse_mode: "MarkdownV2",
    });
  }

  override async deleteMessage(meta: ChannelMeta, messageId: string): Promise<void> {
    const chatId = meta.chatId ?? meta.userId;
    await this.apiCall("deleteMessage", {
      chat_id: chatId,
      message_id: Number(messageId),
    });
  }

  // ── Access control ────────────────────────────────────────────

  override isAllowed(userId: string): boolean {
    if (this.allowedUsers.size === 0) return true;
    return this.allowedUsers.has(userId);
  }

  // ── Webhook handling (for external HTTP server) ───────────────

  /**
   * Process a raw webhook update body. Call this from your HTTP route
   * handler when Telegram POSTs to the webhook URL.
   */
  handleWebhookUpdate(body: unknown): void {
    const update = body as TelegramUpdate;
    this.processUpdate(update);
  }

  // ── Internals ─────────────────────────────────────────────────

  private async setWebhook(url: string): Promise<void> {
    await this.apiCall("setWebhook", { url });
  }

  private poll(): void {
    if (!this.polling) return;

    this.getUpdates()
      .then((updates) => {
        for (const update of updates) {
          this.processUpdate(update);
          this.offset = update.update_id + 1;
        }
      })
      .catch((err) => {
        log.error({ err }, "telegram poll error");
      })
      .finally(() => {
        if (this.polling) {
          this.pollTimer = setTimeout(() => this.poll(), this.pollInterval);
        }
      });
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const result = await this.apiCall<TelegramUpdate[]>("getUpdates", {
      offset: this.offset,
      timeout: 30,
      allowed_updates: ["message", "edited_message"],
    });
    return result ?? [];
  }

  private processUpdate(update: TelegramUpdate): void {
    // Media processing is async (download + transcribe), so defer the
    // whole branch rather than blocking the poll loop.
    void this.processUpdateAsync(update).catch((err) => {
      log.error({ err }, "telegram processUpdate failed");
    });
  }

  private async processUpdateAsync(update: TelegramUpdate): Promise<void> {
    const msg = update.message ?? update.edited_message;
    if (!msg) return;

    const userId = String(msg.from?.id ?? "unknown");

    if (!this.isAllowed(userId)) {
      log.debug({ userId }, "telegram: user not in allowlist, skipping");
      return;
    }

    const caption = (msg.caption ?? "").trim();
    const textOnly = (msg.text ?? "").trim();

    // Start with any explicit text. Media handlers may replace or
    // augment this — e.g. voice becomes a transcript, photos embed
    // the downloaded path so the agent can analyse them.
    let text = textOnly;
    const extraMeta: Record<string, unknown> = {};
    // Attachments the agent should see alongside the text turn. Images
    // populate this so the multimodal model can actually view them;
    // documents/videos populate it so the AttachmentProcessor can
    // surface a "[file: /path]" hint without us rebuilding the string.
    const attachments: InboundAttachment[] = [];

    // ── Voice (Telegram's .ogg/opus "hold to record" messages) ──
    if (msg.voice) {
      await this.sendChatAction(String(msg.chat.id), "typing");
      const path = await this.downloadFile(msg.voice.file_id, ".ogg").catch((err) => {
        log.warn({ err }, "telegram voice download failed");
        return null;
      });
      if (!path) {
        await this.sendReplyRaw(msg, "Sorry, I couldn't download your voice message.");
        return;
      }
      const transcript = await this.safelyTranscribe(path);
      if (!transcript) {
        await this.sendReplyRaw(
          msg,
          "I got your voice message but transcription isn't configured (set GROQ_API_KEY or OPENAI_API_KEY).",
        );
        return;
      }
      text = `[Voice message]: ${transcript}`;
      extraMeta["voiceFilePath"] = path;
      extraMeta["voiceDurationSec"] = msg.voice.duration;
    }

    // ── Audio files (uploaded) ──
    else if (msg.audio) {
      await this.sendChatAction(String(msg.chat.id), "typing");
      const ext = extname(msg.audio.file_name ?? "") || ".mp3";
      const path = await this.downloadFile(msg.audio.file_id, ext).catch(() => null);
      if (!path) {
        await this.sendReplyRaw(msg, "Couldn't download the audio file.");
        return;
      }
      const transcript = await this.safelyTranscribe(path);
      text = transcript
        ? `[Audio transcript]: ${transcript}${caption ? `\nUser caption: ${caption}` : ""}`
        : `[Audio file received at ${path}]${caption ? `\nUser caption: ${caption}` : ""}`;
      extraMeta["audioFilePath"] = path;
    }

    // ── Photos ──
    else if (msg.photo) {
      await this.sendChatAction(String(msg.chat.id), "typing");
      const best = msg.photo[msg.photo.length - 1]; // highest-res
      if (best) {
        const path = await this.downloadFile(best.file_id, ".jpg").catch(() => null);
        if (path) {
          text = caption || "";
          extraMeta["photoFilePath"] = path;
          attachments.push({ kind: "image", path, mimeType: "image/jpeg" });
        } else {
          text = caption ? `[Photo — download failed]\n${caption}` : "[Photo — download failed]";
        }
      }
    }

    // ── Video ──
    else if (msg.video || msg.video_note) {
      await this.sendChatAction(String(msg.chat.id), "upload_video");
      const video = msg.video ?? msg.video_note!;
      const ext = video === msg.video_note ? ".mp4" : (extname((msg.video as { file_name?: string } | undefined)?.file_name ?? "") || ".mp4");
      const path = await this.downloadFile(video.file_id, ext).catch(() => null);
      text = path
        ? `[Video received at ${path}]\n${caption || "User sent a video."}`
        : `[Video — download failed]\n${caption}`;
      if (path) extraMeta["videoFilePath"] = path;
    }

    // ── Documents / files ──
    else if (msg.document) {
      await this.sendChatAction(String(msg.chat.id), "typing");
      const ext = extname(msg.document.file_name ?? "") || "";
      const path = await this.downloadFile(msg.document.file_id, ext).catch(() => null);
      if (path) {
        text = caption || "";
        extraMeta["documentFilePath"] = path;
        const mime = msg.document.mime_type ?? "application/octet-stream";
        const doc: InboundAttachment = {
          kind: mime.startsWith("image/") ? "image" : "document",
          path,
          mimeType: mime,
          ...(msg.document.file_name ? { filename: msg.document.file_name } : {}),
          ...(msg.document.file_size !== undefined ? { size: msg.document.file_size } : {}),
        };
        attachments.push(doc);
      } else {
        text = `[File "${msg.document.file_name ?? "unknown"}" — download failed]\n${caption}`;
      }
      extraMeta["documentName"] = msg.document.file_name;
    }

    if (!text.trim() && attachments.length === 0) return;

    const incoming: IncomingMessage = {
      channel: this.id,
      userId,
      text: text.trim(),
      meta: {
        channel: this.id,
        userId,
        chatId: String(msg.chat.id),
        messageId: String(msg.message_id),
        telegramFrom: msg.from,
        chatType: msg.chat.type,
        ...extraMeta,
      },
      timestamp: msg.date * 1000,
      ...(attachments.length > 0 ? { attachments } : {}),
    };

    this.onMessage(incoming);
  }

  /** Returns the transcript or null when STT isn't configured / fails. */
  private async safelyTranscribe(filePath: string): Promise<string | null> {
    try {
      const { text } = await transcribeAudioFile(this.cfg, filePath);
      return text || null;
    } catch (err) {
      log.warn({ err: (err as Error).message }, "telegram transcription failed");
      return null;
    }
  }

  private async ensureDownloadDir(): Promise<string> {
    if (this.downloadDir) return this.downloadDir;
    const dir = join(tmpdir(), "daemora-telegram");
    await mkdir(dir, { recursive: true });
    this.downloadDir = dir;
    return dir;
  }

  /**
   * Download a Telegram-hosted file by `file_id`. Telegram's two-step
   * flow: getFile → returns relative file_path → fetch from /file/bot<TOKEN>/<path>.
   * Returns the absolute local path on disk.
   */
  private async downloadFile(fileId: string, ext: string): Promise<string> {
    const info = (await this.apiCall<{ file_path: string }>("getFile", { file_id: fileId })) as
      | { file_path: string }
      | null;
    if (!info?.file_path) throw new Error(`Telegram getFile returned no file_path for ${fileId}`);

    const url = `https://api.telegram.org/file/bot${this.token}/${info.file_path}`;
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`Telegram file download ${res.status}`);

    const dir = await this.ensureDownloadDir();
    const outPath = join(dir, `${fileId}${ext.startsWith(".") ? ext : `.${ext || "bin"}`}`);
    await pipeline(Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream), createWriteStream(outPath));
    return outPath;
  }

  private async sendChatAction(chatId: string, action: string): Promise<void> {
    await this.apiCall("sendChatAction", { chat_id: chatId, action });
  }

  /** Plain-text reply used for error paths where MarkdownV2 escaping is overkill. */
  private async sendReplyRaw(msg: TelegramMessage, text: string): Promise<void> {
    await this.apiCall("sendMessage", {
      chat_id: msg.chat.id,
      text,
      reply_to_message_id: msg.message_id,
    });
  }

  private async apiCall<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T | null> {
    const url = `${API_BASE}${this.token}/${method}`;
    try {
      const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      };
      if (params) init.body = JSON.stringify(params);
      const resp = await fetch(url, init);

      if (!resp.ok) {
        const body = await resp.text();
        log.error({ method, status: resp.status, body }, "telegram API error");
        return null;
      }

      const json = (await resp.json()) as { ok: boolean; result: T };
      if (!json.ok) {
        log.error({ method, json }, "telegram API returned ok=false");
        return null;
      }

      return json.result;
    } catch (err) {
      log.error({ err, method }, "telegram API call failed");
      return null;
    }
  }
}

function telegramEndpointForExt(ext: string): { endpoint: string; fieldName: string } {
  const img = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
  const video = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);
  const audio = new Set([".mp3", ".ogg", ".wav", ".m4a", ".oga"]);
  if (img.has(ext)) return { endpoint: "sendPhoto", fieldName: "photo" };
  if (video.has(ext)) return { endpoint: "sendVideo", fieldName: "video" };
  if (audio.has(ext)) return { endpoint: "sendAudio", fieldName: "audio" };
  return { endpoint: "sendDocument", fieldName: "document" };
}
