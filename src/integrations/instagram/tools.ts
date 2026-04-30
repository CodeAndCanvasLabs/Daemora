/**
 * Instagram Graph API tool set exposed to the `instagram` crew.
 *
 * Publishing a photo is a two-step flow:
 *   1. POST /{ig-user-id}/media?image_url=... → returns a container id
 *   2. POST /{ig-user-id}/media_publish?creation_id=<container>
 * `instagram_publish_image` wraps both steps so the agent calls it
 * once with a single URL.
 *
 * Note: IG requires the image/video to be reachable at a public URL.
 * For locally-generated assets, upload to a Daemora-served public
 * endpoint first (outside this tool's scope — pair with tunnel).
 */

import { z } from "zod";

import type { ToolDef } from "../../tools/types.js";
import type { IntegrationManager } from "../IntegrationManager.js";
import { InstagramClient } from "./InstagramClient.js";

export function makeInstagramTools(integrations: IntegrationManager): readonly ToolDef[] {
  const client = new InstagramClient(integrations);

  const listAccounts: ToolDef<z.ZodObject<Record<string, never>>, unknown> = {
    name: "instagram_list_accounts",
    description: "List Instagram Business/Creator accounts the connected Meta user can publish to.",
    category: "channel",
    source: { kind: "core" },
    tags: ["instagram", "accounts"],
    inputSchema: z.object({}),
    async execute() {
      const accounts = await client.listAccounts();
      return accounts.map((a) => ({ igUserId: a.igUserId, username: a.username, pageName: a.pageName }));
    },
  };

  const getProfile: ToolDef<z.ZodObject<{ igUserId: z.ZodString }>, unknown> = {
    name: "instagram_get_profile",
    description: "Fetch username, follower count, and media count for an IG Business account.",
    category: "channel",
    source: { kind: "core" },
    tags: ["instagram", "profile"],
    inputSchema: z.object({ igUserId: z.string().min(1) }),
    async execute({ igUserId }) {
      const token = await client.tokenForIgUser(igUserId);
      return client.raw<unknown>(
        `/${igUserId}?fields=id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url`,
        {},
        token,
      );
    },
  };

  const listMedia: ToolDef<z.ZodObject<{ igUserId: z.ZodString; limit: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "instagram_list_media",
    description: "List recent media posted by an IG Business account.",
    category: "channel",
    source: { kind: "core" },
    tags: ["instagram", "media"],
    inputSchema: z.object({
      igUserId: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async execute({ igUserId, limit }) {
      const token = await client.tokenForIgUser(igUserId);
      return client.raw<unknown>(
        `/${igUserId}/media?fields=id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count&limit=${limit ?? 20}`,
        {},
        token,
      );
    },
  };

  const publishImage: ToolDef<z.ZodObject<{ igUserId: z.ZodString; imageUrl: z.ZodString; caption: z.ZodOptional<z.ZodString> }>, unknown> = {
    name: "instagram_publish_image",
    description: "Publish an image post to an IG Business account. Image URL must be publicly reachable (HTTPS).",
    category: "channel",
    source: { kind: "core" },
    tags: ["instagram", "publish"],
    inputSchema: z.object({
      igUserId: z.string().min(1),
      imageUrl: z.string().url(),
      caption: z.string().max(2200).optional(),
    }),
    async execute({ igUserId, imageUrl, caption }) {
      const token = await client.tokenForIgUser(igUserId);
      // 1. Create container
      const form = new URLSearchParams({ image_url: imageUrl });
      if (caption) form.set("caption", caption);
      const container = await client.raw<{ id?: string }>(
        `/${igUserId}/media?${form.toString()}`,
        { method: "POST" },
        token,
      );
      if (!container.id) return { error: "container creation returned no id", response: container };
      // 2. Publish container
      const published = await client.raw<unknown>(
        `/${igUserId}/media_publish?creation_id=${encodeURIComponent(container.id)}`,
        { method: "POST" },
        token,
      );
      return { containerId: container.id, published };
    },
  };

  const listComments: ToolDef<z.ZodObject<{ mediaId: z.ZodString; igUserId: z.ZodString }>, unknown> = {
    name: "instagram_list_comments",
    description: "List comments on an IG media post.",
    category: "channel",
    source: { kind: "core" },
    tags: ["instagram", "comments"],
    inputSchema: z.object({ mediaId: z.string().min(1), igUserId: z.string().min(1) }),
    async execute({ mediaId, igUserId }) {
      const token = await client.tokenForIgUser(igUserId);
      return client.raw<unknown>(
        `/${mediaId}/comments?fields=id,text,username,timestamp,like_count`,
        {},
        token,
      );
    },
  };

  const replyComment: ToolDef<z.ZodObject<{ commentId: z.ZodString; igUserId: z.ZodString; message: z.ZodString }>, unknown> = {
    name: "instagram_reply_comment",
    description: "Reply to a comment on an IG media post.",
    category: "channel",
    source: { kind: "core" },
    tags: ["instagram", "comments"],
    inputSchema: z.object({
      commentId: z.string().min(1),
      igUserId: z.string().min(1),
      message: z.string().min(1).max(2200),
    }),
    async execute({ commentId, igUserId, message }) {
      const token = await client.tokenForIgUser(igUserId);
      const form = new URLSearchParams({ message });
      return client.raw<unknown>(
        `/${commentId}/replies?${form.toString()}`,
        { method: "POST" },
        token,
      );
    },
  };

  const insights: ToolDef<z.ZodObject<{ igUserId: z.ZodString; metrics: z.ZodArray<z.ZodString>; period: z.ZodOptional<z.ZodEnum<["day", "week", "days_28", "lifetime"]>> }>, unknown> = {
    name: "instagram_insights",
    description: "Account insights. Metrics examples: ['impressions','reach','profile_views']. Period defaults to 'day'.",
    category: "channel",
    source: { kind: "core" },
    tags: ["instagram", "insights"],
    inputSchema: z.object({
      igUserId: z.string().min(1),
      metrics: z.array(z.string()).min(1).max(10),
      period: z.enum(["day", "week", "days_28", "lifetime"]).optional(),
    }),
    async execute({ igUserId, metrics, period }) {
      const token = await client.tokenForIgUser(igUserId);
      const form = new URLSearchParams({
        metric: metrics.join(","),
        period: period ?? "day",
      });
      return client.raw<unknown>(
        `/${igUserId}/insights?${form.toString()}`,
        {},
        token,
      );
    },
  };

  const publishVideo: ToolDef<z.ZodObject<{ igUserId: z.ZodString; videoUrl: z.ZodString; caption: z.ZodOptional<z.ZodString>; mediaType: z.ZodOptional<z.ZodEnum<["REELS", "VIDEO"]>> }>, unknown> = {
    name: "instagram_publish_video",
    description: "Publish a video or Reel. videoUrl must be publicly reachable. Defaults to REELS since IG deprecated standalone video posts.",
    category: "channel",
    source: { kind: "core" },
    tags: ["instagram", "publish", "reels"],
    inputSchema: z.object({
      igUserId: z.string().min(1),
      videoUrl: z.string().url(),
      caption: z.string().max(2200).optional(),
      mediaType: z.enum(["REELS", "VIDEO"]).optional(),
    }),
    async execute({ igUserId, videoUrl, caption, mediaType }) {
      const token = await client.tokenForIgUser(igUserId);
      const form = new URLSearchParams({
        video_url: videoUrl,
        media_type: mediaType ?? "REELS",
      });
      if (caption) form.set("caption", caption);
      const container = await client.raw<{ id?: string }>(
        `/${igUserId}/media?${form.toString()}`,
        { method: "POST" },
        token,
      );
      if (!container.id) return { error: "container creation failed", response: container };
      // IG video containers need a moment before publish is allowed —
      // poll status for up to 60s.
      for (let i = 0; i < 12; i++) {
        const status = await client.raw<{ status_code?: string }>(
          `/${container.id}?fields=status_code`,
          {},
          token,
        );
        if (status.status_code === "FINISHED") break;
        await new Promise((r) => setTimeout(r, 5000));
      }
      const published = await client.raw<unknown>(
        `/${igUserId}/media_publish?creation_id=${encodeURIComponent(container.id)}`,
        { method: "POST" },
        token,
      );
      return { containerId: container.id, published };
    },
  };

  const publishCarousel: ToolDef<z.ZodObject<{ igUserId: z.ZodString; imageUrls: z.ZodArray<z.ZodString>; caption: z.ZodOptional<z.ZodString> }>, unknown> = {
    name: "instagram_publish_carousel",
    description: "Publish a 2–10 image carousel post. All imageUrls must be publicly reachable.",
    category: "channel",
    source: { kind: "core" },
    tags: ["instagram", "publish", "carousel"],
    inputSchema: z.object({
      igUserId: z.string().min(1),
      imageUrls: z.array(z.string().url()).min(2).max(10),
      caption: z.string().max(2200).optional(),
    }),
    async execute({ igUserId, imageUrls, caption }) {
      const token = await client.tokenForIgUser(igUserId);
      // Create one container per image first.
      const childIds: string[] = [];
      for (const url of imageUrls) {
        const form = new URLSearchParams({ image_url: url, is_carousel_item: "true" });
        const c = await client.raw<{ id?: string }>(
          `/${igUserId}/media?${form.toString()}`,
          { method: "POST" },
          token,
        );
        if (!c.id) return { error: `child container creation failed for ${url}` };
        childIds.push(c.id);
      }
      // Create the carousel container referencing the children.
      const form = new URLSearchParams({
        media_type: "CAROUSEL",
        children: childIds.join(","),
      });
      if (caption) form.set("caption", caption);
      const carousel = await client.raw<{ id?: string }>(
        `/${igUserId}/media?${form.toString()}`,
        { method: "POST" },
        token,
      );
      if (!carousel.id) return { error: "carousel container creation failed" };
      const published = await client.raw<unknown>(
        `/${igUserId}/media_publish?creation_id=${encodeURIComponent(carousel.id)}`,
        { method: "POST" },
        token,
      );
      return { carouselId: carousel.id, children: childIds, published };
    },
  };

  const hashtagSearch: ToolDef<z.ZodObject<{ igUserId: z.ZodString; tag: z.ZodString }>, unknown> = {
    name: "instagram_hashtag_search",
    description: "Resolve a hashtag to its IG hashtag id (required before querying media). Tag without the leading #.",
    category: "channel",
    source: { kind: "core" },
    tags: ["instagram", "hashtag"],
    inputSchema: z.object({
      igUserId: z.string().min(1),
      tag: z.string().min(1).max(100),
    }),
    async execute({ igUserId, tag }) {
      const token = await client.tokenForIgUser(igUserId);
      const form = new URLSearchParams({ user_id: igUserId, q: tag.replace(/^#/, "") });
      return client.raw<unknown>(
        `/ig_hashtag_search?${form.toString()}`,
        {},
        token,
      );
    },
  };

  const mediaInsights: ToolDef<z.ZodObject<{ mediaId: z.ZodString; igUserId: z.ZodString; metrics: z.ZodOptional<z.ZodArray<z.ZodString>> }>, unknown> = {
    name: "instagram_media_insights",
    description: "Insights for a single piece of IG media. Default metrics cover impressions + reach + engagement.",
    category: "channel",
    source: { kind: "core" },
    tags: ["instagram", "insights"],
    inputSchema: z.object({
      mediaId: z.string().min(1),
      igUserId: z.string().min(1),
      metrics: z.array(z.string()).max(10).optional(),
    }),
    async execute({ mediaId, igUserId, metrics }) {
      const token = await client.tokenForIgUser(igUserId);
      const selected = metrics && metrics.length > 0
        ? metrics.join(",")
        : "impressions,reach,engagement";
      return client.raw<unknown>(
        `/${mediaId}/insights?metric=${encodeURIComponent(selected)}`,
        {},
        token,
      );
    },
  };

  const deleteComment: ToolDef<z.ZodObject<{ commentId: z.ZodString; igUserId: z.ZodString }>, unknown> = {
    name: "instagram_delete_comment",
    description: "Delete a comment from your IG media.",
    category: "channel",
    source: { kind: "core" },
    tags: ["instagram", "comments"],
    inputSchema: z.object({
      commentId: z.string().min(1),
      igUserId: z.string().min(1),
    }),
    async execute({ commentId, igUserId }) {
      const token = await client.tokenForIgUser(igUserId);
      return client.raw<unknown>(
        `/${commentId}`,
        { method: "DELETE" },
        token,
      );
    },
  };

  const hashtagTopMedia: ToolDef<z.ZodObject<{ igUserId: z.ZodString; hashtagId: z.ZodString; limit: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "instagram_hashtag_top_media",
    description: "Top-ranked posts for a hashtag (use instagram_hashtag_search to get the hashtagId).",
    category: "channel",
    source: { kind: "core" },
    tags: ["instagram", "hashtag"],
    inputSchema: z.object({
      igUserId: z.string().min(1),
      hashtagId: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    async execute({ igUserId, hashtagId, limit }) {
      const token = await client.tokenForIgUser(igUserId);
      const form = new URLSearchParams({
        user_id: igUserId,
        fields: "id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count",
        limit: String(limit ?? 25),
      });
      return client.raw<unknown>(
        `/${hashtagId}/top_media?${form.toString()}`,
        {},
        token,
      );
    },
  };

  const hashtagRecentMedia: ToolDef<z.ZodObject<{ igUserId: z.ZodString; hashtagId: z.ZodString; limit: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "instagram_hashtag_recent_media",
    description: "Recent posts for a hashtag (use instagram_hashtag_search to get the hashtagId).",
    category: "channel",
    source: { kind: "core" },
    tags: ["instagram", "hashtag"],
    inputSchema: z.object({
      igUserId: z.string().min(1),
      hashtagId: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    async execute({ igUserId, hashtagId, limit }) {
      const token = await client.tokenForIgUser(igUserId);
      const form = new URLSearchParams({
        user_id: igUserId,
        fields: "id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count",
        limit: String(limit ?? 25),
      });
      return client.raw<unknown>(
        `/${hashtagId}/recent_media?${form.toString()}`,
        {},
        token,
      );
    },
  };

  const taggedMedia: ToolDef<z.ZodObject<{ igUserId: z.ZodString; limit: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "instagram_tagged_media",
    description: "Media posts where this IG account was tagged.",
    category: "channel",
    source: { kind: "core" },
    tags: ["instagram", "tagged"],
    inputSchema: z.object({
      igUserId: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    async execute({ igUserId, limit }) {
      const token = await client.tokenForIgUser(igUserId);
      return client.raw<unknown>(
        `/${igUserId}/tags?fields=id,caption,media_type,media_url,permalink,timestamp,username&limit=${limit ?? 25}`,
        {},
        token,
      );
    },
  };

  const mentionedMedia: ToolDef<z.ZodObject<{ igUserId: z.ZodString; mediaId: z.ZodString }>, unknown> = {
    name: "instagram_mentioned_media",
    description: "Get a specific media post where the account was @-mentioned (requires mediaId from a mentions webhook).",
    category: "channel",
    source: { kind: "core" },
    tags: ["instagram", "mentions"],
    inputSchema: z.object({
      igUserId: z.string().min(1),
      mediaId: z.string().min(1),
    }),
    async execute({ igUserId, mediaId }) {
      const token = await client.tokenForIgUser(igUserId);
      const form = new URLSearchParams({
        fields: "id,caption,media_type,media_url,permalink,timestamp",
      });
      return client.raw<unknown>(
        `/${igUserId}?fields=mentioned_media.media_id(${encodeURIComponent(mediaId)}){${form.get("fields")}}`,
        {},
        token,
      );
    },
  };

  const storyReplies: ToolDef<z.ZodObject<{ igUserId: z.ZodString }>, unknown> = {
    name: "instagram_story_replies",
    description: "List recent story replies received (via DM). Requires instagram_manage_messages scope.",
    category: "channel",
    source: { kind: "core" },
    tags: ["instagram", "stories"],
    inputSchema: z.object({ igUserId: z.string().min(1) }),
    async execute({ igUserId }) {
      const token = await client.tokenForIgUser(igUserId);
      return client.raw<unknown>(
        `/${igUserId}/conversations?platform=instagram&fields=id,updated_time,snippet,messages{id,from,to,message,created_time}`,
        {},
        token,
      );
    },
  };

  return [
    listAccounts, getProfile, listMedia,
    publishImage, publishVideo, publishCarousel,
    listComments, replyComment, deleteComment,
    hashtagSearch, hashtagTopMedia, hashtagRecentMedia,
    taggedMedia, mentionedMedia, storyReplies,
    insights, mediaInsights,
  ] as unknown as readonly ToolDef[];
}
