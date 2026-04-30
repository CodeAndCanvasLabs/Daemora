/**
 * send_file — deliver a local file to the originating user on their
 * channel.
 *
 * Zero-config call: `send_file({ path, caption? })`. Routing is
 * automatic — the active task's channelMeta is looked up in
 * ChannelManager by taskId, so the agent never has to know which chat
 * on which platform it's talking to.
 *
 * Each channel's `sendFile` override decides what "upload" means:
 *   discord   → multipart attachment (files[0] + payload_json)
 *   telegram  → sendPhoto / sendVideo / sendAudio / sendDocument
 *   slack     → files.uploadV2 3-step flow
 *   whatsapp  → Twilio MediaUrl (needs PUBLIC_URL set)
 *   teams / googlechat → per-channel handlers (where implemented)
 *
 * Tasks without a channel (chat-UI, voice, cron fan-out) return a
 * benign "file is visible in the chat" message — the web UI already
 * renders local paths inline via /api/file.
 */

import { existsSync, statSync } from "node:fs";
import { z } from "zod";

import type { ChannelManager } from "../../channels/ChannelManager.js";
import type { FilesystemGuard } from "../../safety/FilesystemGuard.js";
import { NotFoundError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

/** 50 MB — most chat platforms reject larger uploads. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

const inputSchema = z.object({
  path: z.string().min(1).describe("Absolute path to the local file to send."),
  caption: z.string().max(1024).optional().describe("Optional text shown alongside the file."),
});

export function makeSendFileTool(
  guard: FilesystemGuard,
  channels: ChannelManager,
): ToolDef<typeof inputSchema, string> {
  return {
    name: "send_file",
    description:
      "Send a local file (image, video, document, audio) to the user on the originating channel. Use this after generate_image, screen_capture, create_document, or any tool that produced a file the user asked for — don't just mention the path, actually deliver it.",
    category: "channel",
    source: { kind: "core" },
    tags: ["channel", "send", "file", "upload"],
    inputSchema,
    async execute({ path, caption }, { taskId }) {
      const canonical = guard.ensureAllowed(path, "read");
      if (!existsSync(canonical)) throw new NotFoundError(`File not found: ${canonical}`);
      const s = statSync(canonical);
      if (!s.isFile()) throw new ValidationError(`Not a file: ${canonical}`);
      if (s.size > MAX_FILE_BYTES) {
        throw new ValidationError(
          `File too large (${(s.size / 1024 / 1024).toFixed(1)} MB). Limit is ${MAX_FILE_BYTES / 1024 / 1024} MB.`,
        );
      }
      const res = await channels.sendFileForTask(taskId, canonical, caption);
      return res.message;
    },
  };
}
