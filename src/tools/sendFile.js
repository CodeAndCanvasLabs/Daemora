/**
 * sendFile(channel, target, filePath, caption?) - Send a file/image/video to a user on any channel.
 *
 * The agent uses this to proactively deliver:
 * - Screenshots it captured (screenCapture → sendFile)
 * - Images it generated or processed
 * - Videos it recorded
 * - Documents/PDFs it created (createDocument → sendFile)
 * - Any other file the user should receive
 *
 * channel: "telegram" | "discord" | "slack" | "whatsapp" | "email"
 * target:  chat ID, user ID, channel ID, phone number, or email - depends on channel
 * filePath: absolute path to the local file to send
 * caption: optional text caption alongside the file
 */
import channelRegistry from "../channels/index.js";
import tenantContext from "../tenants/TenantContext.js";
import { existsSync, statSync } from "node:fs";
import filesystemGuard from "../safety/FilesystemGuard.js";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB - most platforms limit around this

export async function sendFile(params) {
  const requestedChannel = params?.channel;
  const filePath = params?.filePath;
  const caption = params?.caption;
  try {
    if (!filePath) return "Error: filePath is required";

    const readCheck = filesystemGuard.checkRead(filePath);
    if (!readCheck.allowed) return `Error: ${readCheck.reason}`;

    if (!existsSync(filePath)) {
      return `Error: File not found: ${filePath}`;
    }

    const size = statSync(filePath).size;
    if (size > MAX_FILE_SIZE) {
      return `Error: File too large (${(size / 1024 / 1024).toFixed(1)} MB). Maximum is 50 MB.`;
    }

    // Always send to the current user's channel — target is derived from TenantContext,
    // never a free-form ID. This prevents sending files to arbitrary external users.
    const store = tenantContext.getStore();
    const channelMeta = store?.channelMeta;

    if (!channelMeta?.channel || (!channelMeta?.chatId && !channelMeta?.channelId)) {
      return "Error: No active channel context. Cannot determine where to send the file.";
    }

    // If a specific channel was requested, verify it matches the current user's channel.
    // Cross-channel sends (e.g. Discord → Telegram) are not supported — each channel is
    // a separate tenant identity and we don't have the user's ID on other channels.
    const targetChannel = requestedChannel?.toLowerCase() || channelMeta.channel;
    if (targetChannel !== channelMeta.channel) {
      return `Error: Cannot send to "${targetChannel}" — you are on "${channelMeta.channel}". Files can only be sent back to the channel you are using.`;
    }

    const ch = channelRegistry.get(channelMeta.channel);
    if (!ch) {
      const available = channelRegistry.list().map((c) => c.name).join(", ");
      return `Error: Channel "${channelMeta.channel}" not found. Available: ${available || "none"}`;
    }
    if (!ch.running) {
      return `Error: Channel "${channelMeta.channel}" is not running.`;
    }
    if (typeof ch.sendFile !== "function") {
      return `Error: Channel "${channelMeta.channel}" does not support file sending yet.`;
    }

    await ch.sendFile(channelMeta, filePath, caption || "");

    return `File sent via ${channelMeta.channel}: ${filePath}`;
  } catch (error) {
    return `Error sending file: ${error.message}`;
  }
}

export const sendFileDescription =
  'sendFile(filePath, caption?, channel?) - Send a file, image, or video back to the current user. ' +
  'Always sends to the user who sent the current message — target is automatic from session context. ' +
  'channel: optional, must match the current channel (cross-channel sends are not supported). ' +
  'filePath: absolute path to the file. caption: optional text alongside the file. ' +
  'Prefer replyWithFile() for simplicity — use sendFile() only when you need to confirm the channel explicitly.';
