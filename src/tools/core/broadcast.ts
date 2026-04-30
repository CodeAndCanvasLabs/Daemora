/**
 * broadcast(text?, filePath?, channels, targets?) — send the same
 * content to multiple channels / users in one go.
 *
 * General-purpose outbound delivery. Works from cron jobs, inside a
 * chat turn, or from a sub-agent. Each `(channel, target)` pair is
 * attempted independently so one failure doesn't kill the whole
 * broadcast — results are returned per recipient.
 *
 * The JS version reads delivery presets via DeliveryPresetStore; that
 * store isn't ported yet (scheduler pulses land in Batch I of the port
 * work) so for now the caller must pass channels + targets explicitly.
 */

import { stat } from "node:fs/promises";
import { z } from "zod";

import type { ChannelManager } from "../../channels/ChannelManager.js";
import type { ChannelMeta } from "../../channels/BaseChannel.js";
import type { FilesystemGuard } from "../../safety/FilesystemGuard.js";
import { NotFoundError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const MAX_FILE_SIZE = 50 * 1024 * 1024;

const targetSchema = z.object({
  channel: z.string().min(1),
  target: z.string().min(1),
});

const inputSchema = z.object({
  text: z.string().optional().describe("Text body of the broadcast."),
  filePath: z.string().optional().describe("Optional file attached to every recipient."),
  caption: z.string().optional().describe("Caption when sending a file."),
  targets: z.array(targetSchema).min(1).max(100)
    .describe("Recipient list — array of {channel, target} pairs."),
}).refine(
  (data) => !!(data.text || data.filePath),
  { message: "Provide `text`, `filePath`, or both." },
);

interface Delivery {
  readonly channel: string;
  readonly target: string;
  readonly ok: boolean;
  readonly error?: string;
}

export function makeBroadcastTool(channels: ChannelManager, guard: FilesystemGuard): ToolDef<typeof inputSchema, unknown> {
  return {
    name: "broadcast",
    description:
      "Send the same text / file to multiple (channel, target) pairs. Per-recipient success tracking.",
    category: "channel",
    source: { kind: "core" },
    tags: ["broadcast", "channel", "bulk", "notify"],
    inputSchema,
    async execute({ text, filePath, caption, targets }, { logger }) {
      let canonical: string | null = null;
      let sizeBytes = 0;
      if (filePath) {
        canonical = guard.ensureAllowed(filePath, "read");
        const s = await stat(canonical).catch(() => null);
        if (!s) throw new NotFoundError(`File not found: ${canonical}`);
        if (!s.isFile()) throw new ValidationError(`Not a file: ${canonical}`);
        if (s.size > MAX_FILE_SIZE) {
          throw new ValidationError(`File too large: ${(s.size / 1024 / 1024).toFixed(1)} MB`);
        }
        sizeBytes = s.size;
      }

      const results: Delivery[] = [];
      for (const { channel, target } of targets) {
        const id = channel.toLowerCase();
        const ch = channels.getChannel(id);
        if (!ch) {
          results.push({ channel: id, target, ok: false, error: `channel '${id}' is not running` });
          continue;
        }
        const meta: ChannelMeta = {
          channel: id,
          userId: target,
          chatId: target,
          to: target,
          phoneNumber: target,
          email: target,
        };
        try {
          if (canonical) await ch.sendFile(meta, canonical, caption ?? text);
          if (text && !canonical) await ch.sendReply(meta, text);
          results.push({ channel: id, target, ok: true });
        } catch (e) {
          const msg = (e as Error).message;
          results.push({ channel: id, target, ok: false, error: msg });
          logger.warn("broadcast delivery failed", { channel: id, target, error: msg });
        }
      }

      const delivered = results.filter((r) => r.ok).length;
      return {
        totalTargets: targets.length,
        delivered,
        failed: targets.length - delivered,
        ...(sizeBytes > 0 ? { fileBytes: sizeBytes } : {}),
        results,
        message: `Broadcast: ${delivered}/${targets.length} delivered`,
      };
    },
  };
}
