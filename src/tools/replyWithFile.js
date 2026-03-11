/**
 * replyWithFile(filePath, caption?) - Send a file back to the user who sent the current message.
 *
 * Reads channel + chatId from TenantContext automatically.
 * The agent never needs to know which channel or chatId — just the file path.
 *
 * Works for images, videos, documents, audio — any file type.
 * The channel adapter auto-detects the type and sends appropriately
 * (e.g. Telegram sends photos as photos, videos as videos).
 */
import tenantContext from "../tenants/TenantContext.js";
import channelRegistry from "../channels/index.js";
import { existsSync, statSync } from "node:fs";
import filesystemGuard from "../safety/FilesystemGuard.js";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export async function replyWithFile(params) {
  const filePath = params?.filePath;
  const caption = params?.caption;
  try {
    if (!filePath) return "Error: filePath is required.";

    const readCheck = filesystemGuard.checkRead(filePath);
    if (!readCheck.allowed) return `Error: ${readCheck.reason}`;

    if (!existsSync(filePath)) {
      return `Error: File not found: ${filePath}`;
    }

    const size = statSync(filePath).size;
    if (size > MAX_FILE_SIZE) {
      return `Error: File too large (${(size / 1024 / 1024).toFixed(1)} MB). Maximum is 50 MB.`;
    }

    const store = tenantContext.getStore();
    const channelMeta = store?.channelMeta;

    if (!channelMeta?.channel || (!channelMeta?.chatId && !channelMeta?.channelId)) {
      return "Error: No active channel context. Cannot determine where to send the file. Use sendFile(channel, target, filePath) instead.";
    }

    const ch = channelRegistry.get(channelMeta.channel);
    if (!ch) {
      return `Error: Channel "${channelMeta.channel}" not available.`;
    }
    if (!ch.running) {
      return `Error: Channel "${channelMeta.channel}" is not running.`;
    }
    if (typeof ch.sendFile !== "function") {
      return `Error: Channel "${channelMeta.channel}" does not support file sending.`;
    }

    await ch.sendFile(channelMeta, filePath, caption || "");

    // Mark that we already replied directly — channel should skip the duplicate text message
    if (store) store.directReplySent = true;

    return `File sent to user: ${filePath}`;
  } catch (error) {
    return `Error sending file: ${error.message}`;
  }
}

export const replyWithFileDescription =
  'replyWithFile(filePath, caption?) - Send a file (image, video, document, audio) back to the user. ' +
  'Automatically uses the current channel — no need to specify channel or chatId. ' +
  'Use after screenCapture, generateImage, createDocument, or any tool that produces a file the user should receive.';
