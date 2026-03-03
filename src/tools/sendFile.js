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
import { existsSync, statSync } from "node:fs";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB - most platforms limit around this

export async function sendFile(channel, target, filePath, caption) {
  try {
    if (!channel) return "Error: channel is required";
    if (!target)  return "Error: target is required (chat ID, user ID, phone, or email)";
    if (!filePath) return "Error: filePath is required";

    if (!existsSync(filePath)) {
      return `Error: File not found: ${filePath}`;
    }

    const size = statSync(filePath).size;
    if (size > MAX_FILE_SIZE) {
      return `Error: File too large (${(size / 1024 / 1024).toFixed(1)} MB). Maximum is 50 MB.`;
    }

    const ch = channelRegistry.get(channel.toLowerCase());
    if (!ch) {
      const available = channelRegistry.list().map((c) => c.name).join(", ");
      return `Error: Channel "${channel}" not found. Available: ${available || "none"}`;
    }

    if (!ch.running) {
      return `Error: Channel "${channel}" is not running.`;
    }

    if (typeof ch.sendFile !== "function") {
      return `Error: Channel "${channel}" does not support file sending yet.`;
    }

    await ch.sendFile({ chatId: target, userId: target, channelId: target }, filePath, caption || "");

    return `File sent via ${channel} to ${target}: ${filePath}`;
  } catch (error) {
    return `Error sending file: ${error.message}`;
  }
}

export const sendFileDescription =
  'sendFile(channel, target, filePath, caption?) - Send a file, image, or video to a user. ' +
  'channel: "telegram"|"discord"|"slack"|"email". ' +
  'target: chat ID (Telegram), user/channel ID (Discord/Slack), or email. ' +
  'filePath: absolute path to the file. caption: optional text alongside the file. ' +
  'Use after screenCapture, createDocument, or imageAnalysis to deliver results to the user.';
