/**
 * create_poll(question, options, ...) — create a poll in a channel.
 *
 * Only channels that override `sendPoll` support this (currently
 * Telegram and Discord). For other channels the tool returns a clear
 * error so the agent knows to fall back to a plain-text question.
 *
 * The agent must pass `channelId` and `chatId` explicitly because
 * tools don't carry implicit channel context in TS (a cleaner contract
 * than the JS version's RequestContext magic).
 */

import { z } from "zod";

import type { ChannelManager } from "../../channels/ChannelManager.js";
import type { ChannelMeta } from "../../channels/BaseChannel.js";
import { NotFoundError, ProviderError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  channelId: z.string().min(1).describe("Channel id, e.g. 'telegram', 'discord'."),
  chatId: z.string().min(1).describe("Chat / room / channel id inside the provider."),
  question: z.string().min(1).max(300),
  options: z.array(z.string().min(1).max(100)).min(2).max(10)
    .describe("2–10 poll options."),
  durationHours: z.number().int().min(1).max(168).default(24),
});

export function makePollTool(channels: ChannelManager): ToolDef<typeof inputSchema, unknown> {
  return {
    name: "create_poll",
    description:
      "Create a poll in a chat channel (supports Telegram / Discord). Requires channelId + chatId explicitly.",
    category: "channel",
    source: { kind: "core" },
    tags: ["poll", "channel", "vote"],
    inputSchema,
    async execute(input, { logger }) {
      const running = channels.runningSet();
      if (!running.has(input.channelId)) {
        throw new NotFoundError(`Channel '${input.channelId}' is not running. Running: ${[...running].join(", ") || "none"}`);
      }

      // Reach into the manager's private map via a typed accessor.
      // We keep this contained so if the manager surface changes we
      // only adjust this one tool.
      const running2 = channels as unknown as { running: Map<string, { sendPoll: (m: ChannelMeta, q: string, o: readonly string[], h?: number) => Promise<void> }> };
      const channel = running2.running.get(input.channelId);
      if (!channel) throw new NotFoundError(`Channel '${input.channelId}' handle unavailable`);

      const meta: ChannelMeta = {
        channel: input.channelId,
        userId: "",
        chatId: input.chatId,
      };

      try {
        await channel.sendPoll(meta, input.question, input.options, input.durationHours);
        logger.info("poll created", { channelId: input.channelId, chatId: input.chatId, options: input.options.length });
        return {
          channelId: input.channelId,
          chatId: input.chatId,
          question: input.question,
          options: input.options,
          durationHours: input.durationHours,
          message: `Poll created: "${input.question}" with ${input.options.length} options`,
        };
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("does not support polls")) {
          throw new ValidationError(`Channel '${input.channelId}' doesn't support polls — ask the user inline instead.`);
        }
        throw new ProviderError(`Poll creation failed: ${msg}`, input.channelId);
      }
    },
  };
}
