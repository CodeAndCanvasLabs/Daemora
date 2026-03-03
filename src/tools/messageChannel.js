/**
 * messageChannel(channel, target, message) - Send a message to any configured channel.
 * Allows the agent to proactively message users, not just reply to inbound tasks.
 * Inspired by OpenClaw's message tool.
 */
import channelRegistry from "../channels/index.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function messageChannel(channel, target, message) {
  try {
    if (!channel) return "Error: channel is required (telegram, whatsapp, email)";
    if (!target) return "Error: target is required (chat ID, phone number, or email address)";
    if (!message) return "Error: message is required";

    const ch = channelRegistry.get(channel.toLowerCase());
    if (!ch) {
      const available = channelRegistry.list().map((c) => c.name).join(", ");
      return `Error: Channel "${channel}" not found. Available channels: ${available || "none"}`;
    }

    if (!ch.running) {
      return `Error: Channel "${channel}" is not running. Check configuration.`;
    }

    // Validate target format
    if (channel.toLowerCase() === "email" && !EMAIL_REGEX.test(target)) {
      return `Error: Invalid email address: ${target}`;
    }

    if (channel.toLowerCase() === "whatsapp" && !target.startsWith("+")) {
      return `Warning: WhatsApp targets should be in E.164 format (e.g., +1234567890). Got: ${target}`;
    }

    // Use channel's sendReply method with synthetic metadata
    await ch.sendReply({ chatId: target, to: target, phoneNumber: target, email: target }, message);

    return `Message sent via ${channel} to ${target}.`;
  } catch (error) {
    return `Error sending message: ${error.message}`;
  }
}

export const messageChannelDescription =
  'messageChannel(channel: string, target: string, message: string) - Proactively send a message on any channel. channel: "telegram"|"whatsapp"|"email". target: chat ID, phone number (+1234567890), or email. Use this to notify users proactively, not just in replies.';
