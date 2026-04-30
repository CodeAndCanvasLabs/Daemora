/**
 * YouTube Data API v3 tool set exposed to the `youtube` crew.
 *
 * Coverage (matches n8n's YouTube node operation list):
 *   search, get_video, my_videos, list_playlists, add_to_playlist,
 *   comment, list_comments, get_channel, list_comment_threads.
 *
 * Upload is intentionally NOT included here: resumable upload needs
 * multipart streaming which we'd wire through its own tool path.
 */

import { z } from "zod";

import type { ToolDef } from "../../tools/types.js";
import type { IntegrationManager } from "../IntegrationManager.js";
import { YouTubeClient } from "./YouTubeClient.js";

export function makeYouTubeTools(integrations: IntegrationManager): readonly ToolDef[] {
  const client = new YouTubeClient(integrations);

  const search: ToolDef<z.ZodObject<{ query: z.ZodString; maxResults: z.ZodOptional<z.ZodNumber>; type: z.ZodOptional<z.ZodEnum<["video", "channel", "playlist"]>> }>, unknown> = {
    name: "youtube_search",
    description: "Search YouTube for videos, channels, or playlists.",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "search"],
    inputSchema: z.object({
      query: z.string().min(1).max(512),
      maxResults: z.number().int().min(1).max(50).optional(),
      type: z.enum(["video", "channel", "playlist"]).optional(),
    }),
    async execute({ query, maxResults, type }) {
      const q = new URLSearchParams({
        part: "snippet",
        q: query,
        maxResults: String(maxResults ?? 10),
        ...(type ? { type } : {}),
      });
      return client.request<unknown>(`/search?${q.toString()}`);
    },
  };

  const getVideo: ToolDef<z.ZodObject<{ videoId: z.ZodString }>, unknown> = {
    name: "youtube_get_video",
    description: "Fetch snippet + statistics for a single video by id.",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "video"],
    inputSchema: z.object({ videoId: z.string().min(1) }),
    async execute({ videoId }) {
      const q = new URLSearchParams({
        part: "snippet,statistics,contentDetails",
        id: videoId,
      });
      return client.request<unknown>(`/videos?${q.toString()}`);
    },
  };

  const myVideos: ToolDef<z.ZodObject<{ maxResults: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "youtube_my_videos",
    description: "List videos uploaded by the authenticated channel.",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "video"],
    inputSchema: z.object({ maxResults: z.number().int().min(1).max(50).optional() }),
    async execute({ maxResults }) {
      // Two-step: /search returns IDs only (and only accepts part=snippet
      // for forMine — `contentDetails` and `statistics` are reserved for
      // /videos and yield 400 otherwise). Then /videos fetches the rich
      // metadata for those IDs in a single call.
      const searchQ = new URLSearchParams({
        part: "snippet",
        forMine: "true",
        type: "video",
        maxResults: String(maxResults ?? 20),
      });
      const searchRes = await client.request<{
        items?: Array<{ id?: { videoId?: string } }>;
      }>(`/search?${searchQ.toString()}`);
      const ids = (searchRes.items ?? [])
        .map((it) => it.id?.videoId)
        .filter((id): id is string => Boolean(id));
      if (ids.length === 0) return { items: [] };
      const videosQ = new URLSearchParams({
        part: "snippet,contentDetails,statistics",
        id: ids.join(","),
      });
      return client.request<unknown>(`/videos?${videosQ.toString()}`);
    },
  };

  const listPlaylists: ToolDef<z.ZodObject<{ maxResults: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "youtube_list_playlists",
    description: "List the authenticated channel's playlists.",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "playlist"],
    inputSchema: z.object({ maxResults: z.number().int().min(1).max(50).optional() }),
    async execute({ maxResults }) {
      const q = new URLSearchParams({
        part: "snippet,contentDetails",
        mine: "true",
        maxResults: String(maxResults ?? 20),
      });
      return client.request<unknown>(`/playlists?${q.toString()}`);
    },
  };

  const addToPlaylist: ToolDef<z.ZodObject<{ playlistId: z.ZodString; videoId: z.ZodString }>, unknown> = {
    name: "youtube_add_to_playlist",
    description: "Append a video to a playlist you own.",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "playlist"],
    inputSchema: z.object({ playlistId: z.string().min(1), videoId: z.string().min(1) }),
    async execute({ playlistId, videoId }) {
      return client.request<unknown>("/playlistItems?part=snippet", {
        method: "POST",
        body: JSON.stringify({
          snippet: {
            playlistId,
            resourceId: { kind: "youtube#video", videoId },
          },
        }),
      });
    },
  };

  const listComments: ToolDef<z.ZodObject<{ videoId: z.ZodString; maxResults: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "youtube_list_comments",
    description: "List top-level comments on a video.",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "comments"],
    inputSchema: z.object({
      videoId: z.string().min(1),
      maxResults: z.number().int().min(1).max(100).optional(),
    }),
    async execute({ videoId, maxResults }) {
      const q = new URLSearchParams({
        part: "snippet,replies",
        videoId,
        maxResults: String(maxResults ?? 20),
      });
      return client.request<unknown>(`/commentThreads?${q.toString()}`);
    },
  };

  const comment: ToolDef<z.ZodObject<{ videoId: z.ZodString; text: z.ZodString }>, unknown> = {
    name: "youtube_comment",
    description: "Post a top-level comment on a video.",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "comment"],
    inputSchema: z.object({
      videoId: z.string().min(1),
      text: z.string().min(1).max(10_000),
    }),
    async execute({ videoId, text }) {
      return client.request<unknown>("/commentThreads?part=snippet", {
        method: "POST",
        body: JSON.stringify({
          snippet: {
            videoId,
            topLevelComment: { snippet: { textOriginal: text } },
          },
        }),
      });
    },
  };

  const replyComment: ToolDef<z.ZodObject<{ parentId: z.ZodString; text: z.ZodString }>, unknown> = {
    name: "youtube_reply_comment",
    description: "Reply to an existing YouTube comment by parent comment id.",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "comment"],
    inputSchema: z.object({
      parentId: z.string().min(1),
      text: z.string().min(1).max(10_000),
    }),
    async execute({ parentId, text }) {
      return client.request<unknown>("/comments?part=snippet", {
        method: "POST",
        body: JSON.stringify({
          snippet: { parentId, textOriginal: text },
        }),
      });
    },
  };

  const myChannel: ToolDef<z.ZodObject<Record<string, never>>, unknown> = {
    name: "youtube_my_channel",
    description: "Fetch the authenticated channel's profile + statistics.",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "channel"],
    inputSchema: z.object({}),
    async execute() {
      const q = new URLSearchParams({
        part: "snippet,statistics,brandingSettings",
        mine: "true",
      });
      return client.request<unknown>(`/channels?${q.toString()}`);
    },
  };

  const createPlaylist: ToolDef<z.ZodObject<{ title: z.ZodString; description: z.ZodOptional<z.ZodString>; privacyStatus: z.ZodOptional<z.ZodEnum<["public", "unlisted", "private"]>> }>, unknown> = {
    name: "youtube_create_playlist",
    description: "Create a new playlist on the authenticated channel.",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "playlist"],
    inputSchema: z.object({
      title: z.string().min(1).max(150),
      description: z.string().max(5000).optional(),
      privacyStatus: z.enum(["public", "unlisted", "private"]).optional(),
    }),
    async execute({ title, description, privacyStatus }) {
      return client.request<unknown>("/playlists?part=snippet,status", {
        method: "POST",
        body: JSON.stringify({
          snippet: { title, ...(description ? { description } : {}) },
          status: { privacyStatus: privacyStatus ?? "private" },
        }),
      });
    },
  };

  const deletePlaylist: ToolDef<z.ZodObject<{ playlistId: z.ZodString }>, unknown> = {
    name: "youtube_delete_playlist",
    description: "Delete a playlist you own.",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "playlist"],
    inputSchema: z.object({ playlistId: z.string().min(1) }),
    async execute({ playlistId }) {
      return client.request<unknown>(
        `/playlists?id=${encodeURIComponent(playlistId)}`,
        { method: "DELETE" },
      );
    },
  };

  const removeFromPlaylist: ToolDef<z.ZodObject<{ playlistItemId: z.ZodString }>, unknown> = {
    name: "youtube_remove_from_playlist",
    description: "Remove an item from a playlist. Use the playlistItem id (returned when listing a playlist), not the video id.",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "playlist"],
    inputSchema: z.object({ playlistItemId: z.string().min(1) }),
    async execute({ playlistItemId }) {
      return client.request<unknown>(
        `/playlistItems?id=${encodeURIComponent(playlistItemId)}`,
        { method: "DELETE" },
      );
    },
  };

  const rateVideo: ToolDef<z.ZodObject<{ videoId: z.ZodString; rating: z.ZodEnum<["like", "dislike", "none"]> }>, unknown> = {
    name: "youtube_rate_video",
    description: "Like, dislike, or clear your rating on a video.",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "video"],
    inputSchema: z.object({
      videoId: z.string().min(1),
      rating: z.enum(["like", "dislike", "none"]),
    }),
    async execute({ videoId, rating }) {
      const q = new URLSearchParams({ id: videoId, rating });
      return client.request<unknown>(`/videos/rate?${q.toString()}`, { method: "POST" });
    },
  };

  const deleteVideo: ToolDef<z.ZodObject<{ videoId: z.ZodString }>, unknown> = {
    name: "youtube_delete_video",
    description: "Delete a video you uploaded.",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "video"],
    inputSchema: z.object({ videoId: z.string().min(1) }),
    async execute({ videoId }) {
      return client.request<unknown>(
        `/videos?id=${encodeURIComponent(videoId)}`,
        { method: "DELETE" },
      );
    },
  };

  const updateVideoMetadata: ToolDef<z.ZodObject<{ videoId: z.ZodString; title: z.ZodOptional<z.ZodString>; description: z.ZodOptional<z.ZodString>; tags: z.ZodOptional<z.ZodArray<z.ZodString>> }>, unknown> = {
    name: "youtube_update_video",
    description: "Update title, description, or tags on a video you own.",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "video"],
    inputSchema: z.object({
      videoId: z.string().min(1),
      title: z.string().max(100).optional(),
      description: z.string().max(5000).optional(),
      tags: z.array(z.string()).max(500).optional(),
    }),
    async execute({ videoId, title, description, tags }) {
      // videos.update requires the full snippet — fetch it, mutate, PUT.
      const current = await client.request<{ items?: Array<{ snippet: Record<string, unknown> }> }>(
        `/videos?part=snippet&id=${encodeURIComponent(videoId)}`,
      );
      const snippet = { ...(current.items?.[0]?.snippet ?? {}) } as Record<string, unknown>;
      if (title !== undefined) snippet["title"] = title;
      if (description !== undefined) snippet["description"] = description;
      if (tags !== undefined) snippet["tags"] = tags;
      return client.request<unknown>("/videos?part=snippet", {
        method: "PUT",
        body: JSON.stringify({ id: videoId, snippet }),
      });
    },
  };

  const deleteComment: ToolDef<z.ZodObject<{ commentId: z.ZodString }>, unknown> = {
    name: "youtube_delete_comment",
    description: "Delete a comment (must be your own or on a video you own).",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "comment"],
    inputSchema: z.object({ commentId: z.string().min(1) }),
    async execute({ commentId }) {
      return client.request<unknown>(
        `/comments?id=${encodeURIComponent(commentId)}`,
        { method: "DELETE" },
      );
    },
  };

  const getPlaylist: ToolDef<z.ZodObject<{ playlistId: z.ZodString }>, unknown> = {
    name: "youtube_get_playlist",
    description: "Fetch a single playlist by id (snippet + status + contentDetails).",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "playlist"],
    inputSchema: z.object({ playlistId: z.string().min(1) }),
    async execute({ playlistId }) {
      const q = new URLSearchParams({
        part: "snippet,status,contentDetails",
        id: playlistId,
      });
      return client.request<unknown>(`/playlists?${q.toString()}`);
    },
  };

  const updatePlaylist: ToolDef<z.ZodObject<{ playlistId: z.ZodString; title: z.ZodOptional<z.ZodString>; description: z.ZodOptional<z.ZodString>; privacyStatus: z.ZodOptional<z.ZodEnum<["public", "unlisted", "private"]>> }>, unknown> = {
    name: "youtube_update_playlist",
    description: "Update a playlist's title, description, or privacy.",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "playlist"],
    inputSchema: z.object({
      playlistId: z.string().min(1),
      title: z.string().max(150).optional(),
      description: z.string().max(5000).optional(),
      privacyStatus: z.enum(["public", "unlisted", "private"]).optional(),
    }),
    async execute({ playlistId, title, description, privacyStatus }) {
      const current = await client.request<{
        items?: Array<{ snippet: { title: string; description?: string }; status: { privacyStatus: string } }>;
      }>(`/playlists?part=snippet,status&id=${encodeURIComponent(playlistId)}`);
      const prior = current.items?.[0];
      const snippet = { ...(prior?.snippet ?? {}) } as Record<string, unknown>;
      if (title !== undefined) snippet["title"] = title;
      if (description !== undefined) snippet["description"] = description;
      const status = {
        ...(prior?.status ?? {}),
        ...(privacyStatus ? { privacyStatus } : {}),
      };
      return client.request<unknown>("/playlists?part=snippet,status", {
        method: "PUT",
        body: JSON.stringify({ id: playlistId, snippet, status }),
      });
    },
  };

  const updateChannel: ToolDef<z.ZodObject<{ channelId: z.ZodString; description: z.ZodOptional<z.ZodString>; keywords: z.ZodOptional<z.ZodString> }>, unknown> = {
    name: "youtube_update_channel",
    description: "Update branding settings (description, keywords) on a channel you own.",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "channel"],
    inputSchema: z.object({
      channelId: z.string().min(1),
      description: z.string().max(1000).optional(),
      keywords: z.string().max(500).optional(),
    }),
    async execute({ channelId, description, keywords }) {
      const current = await client.request<{ items?: Array<{ brandingSettings: { channel?: Record<string, unknown> } }> }>(
        `/channels?part=brandingSettings&id=${encodeURIComponent(channelId)}`,
      );
      const prior = current.items?.[0]?.brandingSettings?.channel ?? {};
      const merged = { ...prior };
      if (description !== undefined) merged["description"] = description;
      if (keywords !== undefined) merged["keywords"] = keywords;
      return client.request<unknown>("/channels?part=brandingSettings", {
        method: "PUT",
        body: JSON.stringify({
          id: channelId,
          brandingSettings: { channel: merged },
        }),
      });
    },
  };

  const listVideoCategories: ToolDef<z.ZodObject<{ regionCode: z.ZodOptional<z.ZodString> }>, unknown> = {
    name: "youtube_list_video_categories",
    description: "List YouTube video categories for a region (defaults to US).",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "categories"],
    inputSchema: z.object({ regionCode: z.string().length(2).optional() }),
    async execute({ regionCode }) {
      const q = new URLSearchParams({
        part: "snippet",
        regionCode: (regionCode ?? "US").toUpperCase(),
      });
      return client.request<unknown>(`/videoCategories?${q.toString()}`);
    },
  };

  const listSubscriptions: ToolDef<z.ZodObject<{ maxResults: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "youtube_list_subscriptions",
    description: "List channels the authenticated user subscribes to.",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "subscriptions"],
    inputSchema: z.object({ maxResults: z.number().int().min(1).max(50).optional() }),
    async execute({ maxResults }) {
      const q = new URLSearchParams({
        part: "snippet,contentDetails",
        mine: "true",
        maxResults: String(maxResults ?? 20),
      });
      return client.request<unknown>(`/subscriptions?${q.toString()}`);
    },
  };

  const subscribe: ToolDef<z.ZodObject<{ channelId: z.ZodString }>, unknown> = {
    name: "youtube_subscribe",
    description: "Subscribe the authenticated user to a channel.",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "subscriptions"],
    inputSchema: z.object({ channelId: z.string().min(1) }),
    async execute({ channelId }) {
      return client.request<unknown>("/subscriptions?part=snippet", {
        method: "POST",
        body: JSON.stringify({
          snippet: { resourceId: { kind: "youtube#channel", channelId } },
        }),
      });
    },
  };

  const unsubscribe: ToolDef<z.ZodObject<{ subscriptionId: z.ZodString }>, unknown> = {
    name: "youtube_unsubscribe",
    description: "Unsubscribe by subscription id (get it from youtube_list_subscriptions).",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "subscriptions"],
    inputSchema: z.object({ subscriptionId: z.string().min(1) }),
    async execute({ subscriptionId }) {
      return client.request<unknown>(
        `/subscriptions?id=${encodeURIComponent(subscriptionId)}`,
        { method: "DELETE" },
      );
    },
  };

  const listCaptions: ToolDef<z.ZodObject<{ videoId: z.ZodString }>, unknown> = {
    name: "youtube_list_captions",
    description: "List caption tracks available for a video.",
    category: "channel",
    source: { kind: "core" },
    tags: ["youtube", "captions"],
    inputSchema: z.object({ videoId: z.string().min(1) }),
    async execute({ videoId }) {
      const q = new URLSearchParams({ part: "snippet", videoId });
      return client.request<unknown>(`/captions?${q.toString()}`);
    },
  };

  // ── Upload ────────────────────────────────────────────────────────
  // Resumable upload — see YouTubeClient.uploadVideo for the protocol.
  // The video file must already exist on disk (typically rendered by
  // the video-editor crew via Remotion). Caller supplies metadata; we
  // surface the new video id + raw API response on success.
  const uploadVideo: ToolDef<
    z.ZodObject<{
      videoPath: z.ZodString;
      title: z.ZodString;
      description: z.ZodOptional<z.ZodString>;
      tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
      categoryId: z.ZodOptional<z.ZodString>;
      privacyStatus: z.ZodOptional<z.ZodEnum<["private", "unlisted", "public"]>>;
      madeForKids: z.ZodOptional<z.ZodBoolean>;
      defaultLanguage: z.ZodOptional<z.ZodString>;
    }>,
    unknown
  > = {
    name: "youtube_upload_video",
    description:
      "Upload a video file to the user's YouTube channel via the resumable upload API. " +
      "Defaults to private — explicitly set privacyStatus:\"public\" to publish. " +
      "Returns { videoId, raw } on success.",
    category: "channel",
    source: { kind: "core" },
    destructive: true,
    tags: ["youtube", "video", "upload"],
    inputSchema: z.object({
      videoPath: z.string().min(1).describe("Absolute path to the video file (mp4 recommended)."),
      title: z.string().min(1).max(100),
      description: z.string().max(5000).optional(),
      tags: z.array(z.string().min(1).max(100)).max(500).optional(),
      categoryId: z.string().min(1).max(8).optional()
        .describe("YouTube category id. Defaults to 22 (People & Blogs). 24 = Entertainment."),
      privacyStatus: z.enum(["private", "unlisted", "public"]).optional()
        .describe("Default 'private' — flip to 'public' only on explicit user approval."),
      madeForKids: z.boolean().optional()
        .describe("YouTube requires this declaration. Default false."),
      defaultLanguage: z.string().min(2).max(10).optional()
        .describe("BCP-47 language tag, e.g. 'en' or 'en-US'."),
    }),
    async execute({ videoPath, title, description, tags, categoryId, privacyStatus, madeForKids, defaultLanguage }) {
      const result = await client.uploadVideo({
        videoPath,
        snippet: {
          title,
          ...(description ? { description } : {}),
          ...(tags && tags.length > 0 ? { tags } : {}),
          ...(categoryId ? { categoryId } : { categoryId: "22" }),
          ...(defaultLanguage ? { defaultLanguage } : {}),
        },
        status: {
          privacyStatus: privacyStatus ?? "private",
          madeForKids: madeForKids ?? false,
          selfDeclaredMadeForKids: madeForKids ?? false,
        },
      });
      return { videoId: result.id, raw: result.raw };
    },
  };

  return [
    search, getVideo, myVideos,
    listPlaylists, getPlaylist, addToPlaylist, createPlaylist, updatePlaylist, deletePlaylist, removeFromPlaylist,
    listComments, comment, replyComment, deleteComment,
    rateVideo, deleteVideo, updateVideoMetadata,
    myChannel, updateChannel, listVideoCategories,
    listSubscriptions, subscribe, unsubscribe, listCaptions,
    uploadVideo,
  ] as unknown as readonly ToolDef[];
}
