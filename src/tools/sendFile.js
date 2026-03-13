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
import tenantManager from "../tenants/TenantManager.js";
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

    // Resolve target channel and metadata.
    // Priority: explicit channel param → current channel from TenantContext.
    // Cross-channel and no-context (cron) sends look up tenant's linked channels.
    const store = tenantContext.getStore();
    const channelMeta = store?.channelMeta;
    const targetChannel = requestedChannel?.toLowerCase() || channelMeta?.channel;

    if (!targetChannel) {
      return "Error: No active channel context and no channel specified. Pass channel param (e.g. 'discord', 'telegram').";
    }

    let targetMeta = channelMeta;

    // Cross-channel or no-context (cron/autonomous) — look up tenant's linked channel identity
    if (!channelMeta?.channel || targetChannel !== channelMeta.channel) {
      const tenantId = store?.tenant?.id;
      if (!tenantId) {
        return `Error: No tenant context — cannot determine your identity on "${targetChannel}".`;
      }
      const linkedChannels = tenantManager.getChannels(tenantId);
      const linked = linkedChannels.find(c => c.channel === targetChannel);
      if (!linked) {
        return `Error: Your account has no "${targetChannel}" identity linked. Link it first: daemora tenant link ${tenantId} ${targetChannel} <userId>`;
      }
      targetMeta = { channel: targetChannel, chatId: linked.user_id, channelId: linked.user_id, userId: linked.user_id };
    }

    const ch = channelRegistry.get(targetMeta.channel);
    if (!ch) {
      const available = channelRegistry.list().map((c) => c.name).join(", ");
      return `Error: Channel "${targetMeta.channel}" not found. Available: ${available || "none"}`;
    }
    if (!ch.running) {
      return `Error: Channel "${targetMeta.channel}" is not running.`;
    }
    if (typeof ch.sendFile !== "function") {
      return `Error: Channel "${targetMeta.channel}" does not support file sending yet.`;
    }

    await ch.sendFile(targetMeta, filePath, caption || "");

    return `File sent via ${targetMeta.channel}: ${filePath}`;
  } catch (error) {
    return `Error sending file: ${error.message}`;
  }
}

export const sendFileDescription =
  'sendFile(filePath, caption?, channel?) - Send a file, image, or video back to the current user. ' +
  'Always sends to the current user — never to arbitrary external targets. ' +
  'channel: optional, specify a different channel (e.g. "telegram") only if the user explicitly requests it and has that channel linked to their account. ' +
  'filePath: absolute path to the file. caption: optional text alongside the file. ' +
  'Prefer replyWithFile() for simplicity — sendFile() is for explicit cross-channel sends.';
