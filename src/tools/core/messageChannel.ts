/**
 * message_channel(channel, target, message) — proactively send a
 * message to any user on any configured channel.
 *
 * Lets the agent initiate conversations (not just reply to inbound
 * tasks). Validates target format (email, E.164 phone), looks up the
 * running channel, and calls its `sendReply` with synthesised meta.
 */

import { z } from "zod";

import type { ChannelManager } from "../../channels/ChannelManager.js";
import type { ChannelMeta } from "../../channels/BaseChannel.js";
import { NotFoundError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  channel: z.string().min(1).describe("Channel id (telegram, discord, slack, whatsapp, email, etc.)"),
  target: z.string().min(1).describe("Chat id / user id / phone number / email — depends on channel."),
  message: z.string().min(1).max(20_000),
});

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function makeMessageChannelTool(channels: ChannelManager): ToolDef<typeof inputSchema, unknown> {
  return {
    name: "message_channel",
    description:
      "Send a proactive message to a user on any configured channel. Works with telegram, discord, slack, whatsapp, email, etc.",
    category: "channel",
    source: { kind: "core" },
    tags: ["message", "channel", "outbound", "notify"],
    inputSchema,
    async execute({ channel, target, message }, { logger }) {
      const id = channel.toLowerCase();
      const ch = channels.getChannel(id);
      if (!ch) {
        const running = [...channels.runningSet()].join(", ") || "none";
        throw new NotFoundError(`Channel '${channel}' is not running. Running: ${running}`);
      }

      // Target format checks — match the JS tool.
      if (id === "email" && !EMAIL_REGEX.test(target)) {
        throw new ValidationError(`Invalid email address: ${target}`);
      }
      if (id === "whatsapp" && !target.startsWith("+")) {
        logger.warn("whatsapp target missing E.164 prefix", { target });
      }

      // Synthesise metadata. The chat/user/phone/email fields are
      // duplicated because different channels read from different keys.
      const meta: ChannelMeta = {
        channel: id,
        userId: target,
        chatId: target,
        to: target,
        phoneNumber: target,
        email: target,
      };

      await ch.sendReply(meta, message);
      return {
        channel: id,
        target,
        sent: true,
        message: `Message sent to ${target} via ${id}`,
      };
    },
  };
}
