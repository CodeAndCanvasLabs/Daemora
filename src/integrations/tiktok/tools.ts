/**
 * TikTok tools exposed to the `tiktok-crew`.
 *
 * Coverage is intentionally conservative — TikTok's API changes
 * frequently and unaudited apps get visibility restrictions. We ship:
 *   userInfo, userStats, videoList, publishByUrl, initInboxUpload,
 *   publishStatus, comments list.
 *
 * Publishing from a URL (publishByUrl) requires the source domain to
 * be verified in TikTok's Developer Console under "Domain Verification".
 * For local files use `initInboxUpload` which returns an upload URL
 * the caller POSTs the file to directly.
 */

import { readFile, stat } from "node:fs/promises";
import { extname, resolve as resolvePath } from "node:path";

import { z } from "zod";

import type { ToolDef } from "../../tools/types.js";
import { ProviderError } from "../../util/errors.js";
import type { IntegrationManager } from "../IntegrationManager.js";
import { TikTokClient } from "./TikTokClient.js";

export function makeTikTokTools(integrations: IntegrationManager): readonly ToolDef[] {
  const client = new TikTokClient(integrations);

  const userInfo: ToolDef<z.ZodObject<Record<string, never>>, unknown> = {
    name: "tiktok_user_info",
    description: "Return the authenticated TikTok user profile (open_id, union_id, display_name, avatar, bio).",
    category: "channel",
    source: { kind: "core" },
    tags: ["tiktok", "user"],
    inputSchema: z.object({}),
    async execute() {
      const url = "/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username,bio_description,profile_deep_link,is_verified";
      return client.request<unknown>(url);
    },
  };

  const userStats: ToolDef<z.ZodObject<Record<string, never>>, unknown> = {
    name: "tiktok_user_stats",
    description: "Return follower / following / likes / video counts for the authenticated user.",
    category: "channel",
    source: { kind: "core" },
    tags: ["tiktok", "stats"],
    inputSchema: z.object({}),
    async execute() {
      const url = "/v2/user/info/?fields=follower_count,following_count,likes_count,video_count";
      return client.request<unknown>(url);
    },
  };

  const videoList: ToolDef<z.ZodObject<{
    cursor: z.ZodOptional<z.ZodNumber>;
    maxResults: z.ZodOptional<z.ZodNumber>;
  }>, unknown> = {
    name: "tiktok_video_list",
    description: "List the authenticated user's videos. Use `cursor` from a previous response to paginate.",
    category: "channel",
    source: { kind: "core" },
    tags: ["tiktok", "video", "list"],
    inputSchema: z.object({
      cursor: z.number().int().nonnegative().optional(),
      maxResults: z.number().int().min(1).max(20).optional(),
    }),
    async execute({ cursor, maxResults }) {
      return client.request<unknown>("/v2/video/list/?fields=id,title,video_description,create_time,cover_image_url,share_url,duration,view_count,like_count,comment_count,share_count", {
        method: "POST",
        body: JSON.stringify({
          max_count: maxResults ?? 10,
          ...(cursor !== undefined ? { cursor } : {}),
        }),
      });
    },
  };

  const publishByUrl: ToolDef<z.ZodObject<{
    videoUrl: z.ZodString;
    title: z.ZodString;
    privacy: z.ZodOptional<z.ZodEnum<["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"]>>;
    disableComment: z.ZodOptional<z.ZodBoolean>;
    disableDuet: z.ZodOptional<z.ZodBoolean>;
    disableStitch: z.ZodOptional<z.ZodBoolean>;
  }>, unknown> = {
    name: "tiktok_publish_by_url",
    description: "Publish a video hosted on a verified domain. Returns a publish_id — poll tiktok_publish_status for progress. NOTE: unaudited apps force visibility to SELF_ONLY.",
    category: "channel",
    source: { kind: "core" },
    tags: ["tiktok", "publish"],
    inputSchema: z.object({
      videoUrl: z.string().url(),
      title: z.string().min(1).max(2200),
      privacy: z.enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"]).optional(),
      disableComment: z.boolean().optional(),
      disableDuet: z.boolean().optional(),
      disableStitch: z.boolean().optional(),
    }),
    async execute({ videoUrl, title, privacy, disableComment, disableDuet, disableStitch }) {
      return client.request<unknown>("/v2/post/publish/content/init/", {
        method: "POST",
        body: JSON.stringify({
          post_info: {
            title,
            privacy_level: privacy ?? "SELF_ONLY",
            ...(disableComment !== undefined ? { disable_comment: disableComment } : {}),
            ...(disableDuet !== undefined ? { disable_duet: disableDuet } : {}),
            ...(disableStitch !== undefined ? { disable_stitch: disableStitch } : {}),
          },
          source_info: {
            source: "PULL_FROM_URL",
            video_url: videoUrl,
          },
        }),
      });
    },
  };

  const initInboxUpload: ToolDef<z.ZodObject<{
    videoSizeBytes: z.ZodNumber;
    chunkSizeBytes: z.ZodOptional<z.ZodNumber>;
  }>, unknown> = {
    name: "tiktok_init_inbox_upload",
    description: "Initialise a chunked upload for a local video. Response contains `upload_url` — PUT file chunks to it. Video lands in the user's TikTok inbox as a draft.",
    category: "channel",
    source: { kind: "core" },
    tags: ["tiktok", "upload"],
    inputSchema: z.object({
      videoSizeBytes: z.number().int().positive(),
      chunkSizeBytes: z.number().int().positive().optional(),
    }),
    async execute({ videoSizeBytes, chunkSizeBytes }) {
      return client.request<unknown>("/v2/post/publish/inbox/video/init/", {
        method: "POST",
        body: JSON.stringify({
          source_info: {
            source: "FILE_UPLOAD",
            video_size: videoSizeBytes,
            chunk_size: chunkSizeBytes ?? videoSizeBytes,
            total_chunk_count: 1,
          },
        }),
      });
    },
  };

  const finalizeInboxUpload: ToolDef<z.ZodObject<{
    videoPath: z.ZodString;
  }>, unknown> = {
    name: "tiktok_finalize_inbox_upload",
    description: "Upload a local video file to TikTok inbox in one shot — calls init then PUTs the bytes server-side. Returns publish_id; poll tiktok_publish_status until publish_complete. File must be ≤128 MB.",
    category: "channel",
    source: { kind: "core" },
    tags: ["tiktok", "upload"],
    inputSchema: z.object({
      videoPath: z.string().min(1),
    }),
    async execute({ videoPath }) {
      const abs = resolvePath(videoPath);
      let s;
      try {
        s = await stat(abs);
      } catch {
        throw new ProviderError(`tiktok_finalize_inbox_upload: file not found: ${abs}`, "tiktok");
      }
      if (!s.isFile()) {
        throw new ProviderError(`tiktok_finalize_inbox_upload: not a file: ${abs}`, "tiktok");
      }
      const size = s.size;
      if (size === 0) {
        throw new ProviderError(`tiktok_finalize_inbox_upload: file is empty: ${abs}`, "tiktok");
      }
      const MAX = 128 * 1024 * 1024;
      if (size > MAX) {
        throw new ProviderError(
          `tiktok_finalize_inbox_upload: file is ${size} bytes; single-chunk limit is ${MAX} (128 MB). Split into chunks via tiktok_init_inbox_upload + manual PUTs, or shorten the video.`,
          "tiktok",
        );
      }

      const init = await client.request<{
        data?: { publish_id?: string; upload_url?: string };
        error?: { code?: string; message?: string };
      }>("/v2/post/publish/inbox/video/init/", {
        method: "POST",
        body: JSON.stringify({
          source_info: {
            source: "FILE_UPLOAD",
            video_size: size,
            chunk_size: size,
            total_chunk_count: 1,
          },
        }),
      });
      const uploadUrl = init.data?.upload_url;
      const publishId = init.data?.publish_id;
      if (!uploadUrl || !publishId) {
        throw new ProviderError(
          `tiktok_finalize_inbox_upload: init response missing upload_url/publish_id: ${JSON.stringify(init).slice(0, 300)}`,
          "tiktok",
        );
      }

      const ext = extname(abs).toLowerCase();
      const contentType =
        ext === ".mov" ? "video/quicktime" :
        ext === ".webm" ? "video/webm" :
        ext === ".mpeg" || ext === ".mpg" ? "video/mpeg" :
        "video/mp4";

      const buf = await readFile(abs);
      const putResp = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(size),
          "Content-Range": `bytes 0-${size - 1}/${size}`,
        },
        body: new Uint8Array(buf),
      });
      if (putResp.status !== 201 && putResp.status !== 200) {
        const body = await putResp.text().catch(() => "");
        throw new ProviderError(
          `TikTok upload PUT ${putResp.status}: ${body.slice(0, 300)}`,
          "tiktok",
        );
      }

      return {
        publishId,
        uploadStatus: "uploaded",
        sizeBytes: size,
        note: "Use tiktok_publish_status with this publish_id to poll until publish_complete.",
      };
    },
  };

  const publishStatus: ToolDef<z.ZodObject<{ publishId: z.ZodString }>, unknown> = {
    name: "tiktok_publish_status",
    description: "Poll the status of a publish or upload (returns processing / uploaded / downloaded / publish_complete / failed).",
    category: "channel",
    source: { kind: "core" },
    tags: ["tiktok", "publish", "status"],
    inputSchema: z.object({ publishId: z.string().min(1) }),
    async execute({ publishId }) {
      return client.request<unknown>("/v2/post/publish/status/fetch/", {
        method: "POST",
        body: JSON.stringify({ publish_id: publishId }),
      });
    },
  };

  const commentList: ToolDef<z.ZodObject<{
    videoId: z.ZodString;
    cursor: z.ZodOptional<z.ZodNumber>;
    maxResults: z.ZodOptional<z.ZodNumber>;
  }>, unknown> = {
    name: "tiktok_comment_list",
    description: "List comments under a video.",
    category: "channel",
    source: { kind: "core" },
    tags: ["tiktok", "comment", "list"],
    inputSchema: z.object({
      videoId: z.string().min(1),
      cursor: z.number().int().nonnegative().optional(),
      maxResults: z.number().int().min(1).max(50).optional(),
    }),
    async execute({ videoId, cursor, maxResults }) {
      return client.request<unknown>("/v2/video/comment/list/", {
        method: "POST",
        body: JSON.stringify({
          video_id: videoId,
          max_count: maxResults ?? 20,
          ...(cursor !== undefined ? { cursor } : {}),
        }),
      });
    },
  };

  const commentReply: ToolDef<z.ZodObject<{
    videoId: z.ZodString;
    commentId: z.ZodString;
    text: z.ZodString;
  }>, unknown> = {
    name: "tiktok_comment_reply",
    description: "Reply to a comment on one of the user's videos.",
    category: "channel",
    source: { kind: "core" },
    tags: ["tiktok", "comment", "reply"],
    inputSchema: z.object({
      videoId: z.string().min(1),
      commentId: z.string().min(1),
      text: z.string().min(1).max(150),
    }),
    async execute({ videoId, commentId, text }) {
      return client.request<unknown>("/v2/video/comment/reply/", {
        method: "POST",
        body: JSON.stringify({
          video_id: videoId,
          parent_comment_id: commentId,
          text,
        }),
      });
    },
  };

  return [
    userInfo, userStats, videoList,
    publishByUrl, initInboxUpload, finalizeInboxUpload, publishStatus,
    commentList, commentReply,
  ] as unknown as readonly ToolDef[];
}
