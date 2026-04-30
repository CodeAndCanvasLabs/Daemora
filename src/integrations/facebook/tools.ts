/**
 * Facebook Pages tool set — what the `facebook` crew exposes.
 * Operation list mirrors n8n's FacebookGraphApi node: list pages, post
 * to page, list posts, list insights, manage comments.
 */

import { z } from "zod";

import type { ToolDef } from "../../tools/types.js";
import type { IntegrationManager } from "../IntegrationManager.js";
import { FacebookClient } from "./FacebookClient.js";

export function makeFacebookTools(integrations: IntegrationManager): readonly ToolDef[] {
  const client = new FacebookClient(integrations);

  const listPages: ToolDef<z.ZodObject<Record<string, never>>, unknown> = {
    name: "facebook_list_pages",
    description: "List Pages the connected Facebook user manages.",
    category: "channel",
    source: { kind: "core" },
    tags: ["facebook", "pages"],
    inputSchema: z.object({}),
    async execute() {
      const pages = await client.listPages();
      return pages.map((p) => ({ id: p.id, name: p.name, category: p.category }));
    },
  };

  const postToPage: ToolDef<z.ZodObject<{ pageId: z.ZodString; message: z.ZodString; linkUrl: z.ZodOptional<z.ZodString> }>, unknown> = {
    name: "facebook_post_to_page",
    description: "Publish a post on a Facebook Page you manage.",
    category: "channel",
    source: { kind: "core" },
    tags: ["facebook", "post"],
    inputSchema: z.object({
      pageId: z.string().min(1),
      message: z.string().min(1).max(63_206),
      linkUrl: z.string().url().optional(),
    }),
    async execute({ pageId, message, linkUrl }) {
      const token = await client.pageToken(pageId);
      const body: Record<string, string> = { message };
      if (linkUrl) body["link"] = linkUrl;
      const form = new URLSearchParams(body);
      return client.request<unknown>(
        `/${pageId}/feed?${form.toString()}`,
        { method: "POST" },
        token,
      );
    },
  };

  const listPagePosts: ToolDef<z.ZodObject<{ pageId: z.ZodString; limit: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "facebook_list_page_posts",
    description: "List recent posts on a Page you manage.",
    category: "channel",
    source: { kind: "core" },
    tags: ["facebook", "post"],
    inputSchema: z.object({
      pageId: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async execute({ pageId, limit }) {
      const token = await client.pageToken(pageId);
      return client.request<unknown>(
        `/${pageId}/posts?fields=id,message,created_time,permalink_url,reactions.summary(true),comments.summary(true)&limit=${limit ?? 20}`,
        {},
        token,
      );
    },
  };

  const pageInsights: ToolDef<z.ZodObject<{ pageId: z.ZodString; metrics: z.ZodArray<z.ZodString> }>, unknown> = {
    name: "facebook_page_insights",
    description: "Fetch insights metrics for a Page. metrics examples: ['page_impressions','page_post_engagements','page_fans'].",
    category: "channel",
    source: { kind: "core" },
    tags: ["facebook", "insights"],
    inputSchema: z.object({
      pageId: z.string().min(1),
      metrics: z.array(z.string()).min(1).max(10),
    }),
    async execute({ pageId, metrics }) {
      const token = await client.pageToken(pageId);
      return client.request<unknown>(
        `/${pageId}/insights?metric=${encodeURIComponent(metrics.join(","))}`,
        {},
        token,
      );
    },
  };

  const listComments: ToolDef<z.ZodObject<{ objectId: z.ZodString; pageId: z.ZodString; limit: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "facebook_list_comments",
    description: "List comments on a Page post (or any Graph object id).",
    category: "channel",
    source: { kind: "core" },
    tags: ["facebook", "comments"],
    inputSchema: z.object({
      objectId: z.string().min(1),
      pageId: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async execute({ objectId, pageId, limit }) {
      const token = await client.pageToken(pageId);
      return client.request<unknown>(
        `/${objectId}/comments?fields=id,from,message,created_time,like_count,comment_count&limit=${limit ?? 25}`,
        {},
        token,
      );
    },
  };

  const replyComment: ToolDef<z.ZodObject<{ commentId: z.ZodString; pageId: z.ZodString; message: z.ZodString }>, unknown> = {
    name: "facebook_reply_comment",
    description: "Reply to an existing comment on a Page post.",
    category: "channel",
    source: { kind: "core" },
    tags: ["facebook", "comments"],
    inputSchema: z.object({
      commentId: z.string().min(1),
      pageId: z.string().min(1),
      message: z.string().min(1).max(8000),
    }),
    async execute({ commentId, pageId, message }) {
      const token = await client.pageToken(pageId);
      const form = new URLSearchParams({ message });
      return client.request<unknown>(
        `/${commentId}/comments?${form.toString()}`,
        { method: "POST" },
        token,
      );
    },
  };

  const deletePost: ToolDef<z.ZodObject<{ postId: z.ZodString; pageId: z.ZodString }>, unknown> = {
    name: "facebook_delete_post",
    description: "Delete a post on a Page you manage.",
    category: "channel",
    source: { kind: "core" },
    tags: ["facebook", "post"],
    inputSchema: z.object({ postId: z.string().min(1), pageId: z.string().min(1) }),
    async execute({ postId, pageId }) {
      const token = await client.pageToken(pageId);
      return client.request<unknown>(`/${postId}`, { method: "DELETE" }, token);
    },
  };

  const scheduledPost: ToolDef<z.ZodObject<{ pageId: z.ZodString; message: z.ZodString; scheduledPublishTime: z.ZodNumber; linkUrl: z.ZodOptional<z.ZodString> }>, unknown> = {
    name: "facebook_schedule_post",
    description: "Schedule a post on a Page for a future time (Unix seconds). Must be 10+ minutes in the future and <= 6 months out.",
    category: "channel",
    source: { kind: "core" },
    tags: ["facebook", "schedule"],
    inputSchema: z.object({
      pageId: z.string().min(1),
      message: z.string().min(1).max(63_206),
      scheduledPublishTime: z.number().int().min(0),
      linkUrl: z.string().url().optional(),
    }),
    async execute({ pageId, message, scheduledPublishTime, linkUrl }) {
      const token = await client.pageToken(pageId);
      const body: Record<string, string> = {
        message,
        published: "false",
        scheduled_publish_time: String(scheduledPublishTime),
      };
      if (linkUrl) body["link"] = linkUrl;
      const form = new URLSearchParams(body);
      return client.request<unknown>(
        `/${pageId}/feed?${form.toString()}`,
        { method: "POST" },
        token,
      );
    },
  };

  const uploadPhoto: ToolDef<z.ZodObject<{ pageId: z.ZodString; imageUrl: z.ZodString; caption: z.ZodOptional<z.ZodString> }>, unknown> = {
    name: "facebook_upload_photo",
    description: "Publish a photo post on a Page. imageUrl must be publicly reachable.",
    category: "channel",
    source: { kind: "core" },
    tags: ["facebook", "post"],
    inputSchema: z.object({
      pageId: z.string().min(1),
      imageUrl: z.string().url(),
      caption: z.string().max(8000).optional(),
    }),
    async execute({ pageId, imageUrl, caption }) {
      const token = await client.pageToken(pageId);
      const body: Record<string, string> = { url: imageUrl };
      if (caption) body["caption"] = caption;
      return client.request<unknown>(
        `/${pageId}/photos?${new URLSearchParams(body).toString()}`,
        { method: "POST" },
        token,
      );
    },
  };

  const editPost: ToolDef<z.ZodObject<{ postId: z.ZodString; pageId: z.ZodString; message: z.ZodString }>, unknown> = {
    name: "facebook_edit_post",
    description: "Edit the message body of an existing Page post.",
    category: "channel",
    source: { kind: "core" },
    tags: ["facebook", "post"],
    inputSchema: z.object({
      postId: z.string().min(1),
      pageId: z.string().min(1),
      message: z.string().min(1).max(63_206),
    }),
    async execute({ postId, pageId, message }) {
      const token = await client.pageToken(pageId);
      const form = new URLSearchParams({ message });
      return client.request<unknown>(
        `/${postId}?${form.toString()}`,
        { method: "POST" },
        token,
      );
    },
  };

  const postInsights: ToolDef<z.ZodObject<{ postId: z.ZodString; pageId: z.ZodString; metrics: z.ZodArray<z.ZodString> }>, unknown> = {
    name: "facebook_post_insights",
    description: "Insights for a single Page post. Metrics examples: ['post_impressions','post_reactions_by_type_total'].",
    category: "channel",
    source: { kind: "core" },
    tags: ["facebook", "insights"],
    inputSchema: z.object({
      postId: z.string().min(1),
      pageId: z.string().min(1),
      metrics: z.array(z.string()).min(1).max(10),
    }),
    async execute({ postId, pageId, metrics }) {
      const token = await client.pageToken(pageId);
      return client.request<unknown>(
        `/${postId}/insights?metric=${encodeURIComponent(metrics.join(","))}`,
        {},
        token,
      );
    },
  };

  const searchPages: ToolDef<z.ZodObject<{ query: z.ZodString; limit: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "facebook_search_pages",
    description: "Search public Pages by name.",
    category: "channel",
    source: { kind: "core" },
    tags: ["facebook", "search"],
    inputSchema: z.object({
      query: z.string().min(1).max(200),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async execute({ query, limit }) {
      return client.request<unknown>(
        `/pages/search?q=${encodeURIComponent(query)}&fields=id,name,category,link&limit=${limit ?? 20}`,
      );
    },
  };

  const likePost: ToolDef<z.ZodObject<{ postId: z.ZodString; pageId: z.ZodString }>, unknown> = {
    name: "facebook_like_post",
    description: "Like a Page post as the Page itself.",
    category: "channel",
    source: { kind: "core" },
    tags: ["facebook", "reaction"],
    inputSchema: z.object({ postId: z.string().min(1), pageId: z.string().min(1) }),
    async execute({ postId, pageId }) {
      const token = await client.pageToken(pageId);
      return client.request<unknown>(`/${postId}/likes`, { method: "POST" }, token);
    },
  };

  const unlikePost: ToolDef<z.ZodObject<{ postId: z.ZodString; pageId: z.ZodString }>, unknown> = {
    name: "facebook_unlike_post",
    description: "Remove the Page's like from a post.",
    category: "channel",
    source: { kind: "core" },
    tags: ["facebook", "reaction"],
    inputSchema: z.object({ postId: z.string().min(1), pageId: z.string().min(1) }),
    async execute({ postId, pageId }) {
      const token = await client.pageToken(pageId);
      return client.request<unknown>(`/${postId}/likes`, { method: "DELETE" }, token);
    },
  };

  const getPost: ToolDef<z.ZodObject<{ postId: z.ZodString; pageId: z.ZodString }>, unknown> = {
    name: "facebook_get_post",
    description: "Fetch a single Page post with engagement summary.",
    category: "channel",
    source: { kind: "core" },
    tags: ["facebook", "post"],
    inputSchema: z.object({ postId: z.string().min(1), pageId: z.string().min(1) }),
    async execute({ postId, pageId }) {
      const token = await client.pageToken(pageId);
      return client.request<unknown>(
        `/${postId}?fields=id,message,created_time,permalink_url,reactions.summary(true),comments.summary(true),shares`,
        {},
        token,
      );
    },
  };

  const listPageConversations: ToolDef<z.ZodObject<{ pageId: z.ZodString; limit: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "facebook_list_conversations",
    description: "List the Page's Messenger conversations (requires pages_messaging scope).",
    category: "channel",
    source: { kind: "core" },
    tags: ["facebook", "messenger"],
    inputSchema: z.object({
      pageId: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async execute({ pageId, limit }) {
      const token = await client.pageToken(pageId);
      return client.request<unknown>(
        `/${pageId}/conversations?fields=id,snippet,updated_time,unread_count,participants&limit=${limit ?? 20}`,
        {},
        token,
      );
    },
  };

  const sendMessengerMessage: ToolDef<z.ZodObject<{ pageId: z.ZodString; recipientId: z.ZodString; text: z.ZodString }>, unknown> = {
    name: "facebook_send_message",
    description: "Send a Messenger message from the Page to a user. recipientId is the PSID from listing conversations.",
    category: "channel",
    source: { kind: "core" },
    tags: ["facebook", "messenger"],
    inputSchema: z.object({
      pageId: z.string().min(1),
      recipientId: z.string().min(1),
      text: z.string().min(1).max(2000),
    }),
    async execute({ pageId, recipientId, text }) {
      const token = await client.pageToken(pageId);
      return client.request<unknown>(
        `/${pageId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            recipient: { id: recipientId },
            messaging_type: "RESPONSE",
            message: { text },
          }),
        },
        token,
      );
    },
  };

  const listAlbums: ToolDef<z.ZodObject<{ pageId: z.ZodString; limit: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "facebook_list_albums",
    description: "List photo albums on a Page.",
    category: "channel",
    source: { kind: "core" },
    tags: ["facebook", "albums"],
    inputSchema: z.object({
      pageId: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async execute({ pageId, limit }) {
      const token = await client.pageToken(pageId);
      return client.request<unknown>(
        `/${pageId}/albums?fields=id,name,description,count,created_time&limit=${limit ?? 25}`,
        {},
        token,
      );
    },
  };

  const createAlbum: ToolDef<z.ZodObject<{ pageId: z.ZodString; name: z.ZodString; description: z.ZodOptional<z.ZodString> }>, unknown> = {
    name: "facebook_create_album",
    description: "Create a new photo album on a Page.",
    category: "channel",
    source: { kind: "core" },
    tags: ["facebook", "albums"],
    inputSchema: z.object({
      pageId: z.string().min(1),
      name: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
    }),
    async execute({ pageId, name, description }) {
      const token = await client.pageToken(pageId);
      const form = new URLSearchParams({ name });
      if (description) form.set("message", description);
      return client.request<unknown>(
        `/${pageId}/albums?${form.toString()}`,
        { method: "POST" },
        token,
      );
    },
  };

  return [
    listPages, postToPage, scheduledPost, uploadPhoto, editPost, deletePost, getPost,
    listPagePosts, pageInsights, postInsights,
    likePost, unlikePost, listComments, replyComment, searchPages,
    listPageConversations, sendMessengerMessage,
    listAlbums, createAlbum,
  ] as unknown as readonly ToolDef[];
}
