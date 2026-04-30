import { z } from "zod";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  message: z.string().min(1).max(10_000).describe("Text to send to the user immediately, mid-task."),
});

export const replyToUserTool: ToolDef<typeof inputSchema, { delivered: boolean }> = {
  name: "reply_to_user",
  description: "Send a message to the user mid-task without stopping. Use for progress updates or acknowledgements while continuing work.",
  category: "core",
  source: { kind: "core" },
  alwaysOn: true,
  inputSchema,
  async execute({ message }, { logger }) {
    // In the SSE stream, this surfaces as a text:delta event.
    // The agent loop translates it. For now, log + return.
    logger.info("reply_to_user called", { messageLength: message.length });
    return { delivered: true };
  },
};
