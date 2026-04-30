/**
 * Twitter/X tool set exposed to the `twitter` crew.
 *
 * Endpoint coverage matches n8n's Twitter V2 node — posts, replies,
 * quotes, search, timelines, likes, retweets, deletes. Every tool
 * goes through TwitterClient so auth + refresh stay centralized.
 */

import { z } from "zod";

import type { ToolDef } from "../../tools/types.js";
import type { IntegrationManager } from "../IntegrationManager.js";
import { TwitterClient } from "./TwitterClient.js";

export function makeTwitterTools(integrations: IntegrationManager): readonly ToolDef[] {
  const client = new TwitterClient(integrations);

  const post: ToolDef<z.ZodObject<{ text: z.ZodString; replyToId: z.ZodOptional<z.ZodString>; quoteTweetId: z.ZodOptional<z.ZodString> }>, unknown> = {
    name: "twitter_post",
    description: "Publish a new tweet. Optionally reply to a tweet or quote another tweet.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "post"],
    inputSchema: z.object({
      text: z.string().min(1).max(4000),
      replyToId: z.string().optional(),
      quoteTweetId: z.string().optional(),
    }),
    async execute({ text, replyToId, quoteTweetId }) {
      const body: Record<string, unknown> = { text };
      if (replyToId) body["reply"] = { in_reply_to_tweet_id: replyToId };
      if (quoteTweetId) body["quote_tweet_id"] = quoteTweetId;
      return client.request<unknown>("/tweets", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
  };

  const del: ToolDef<z.ZodObject<{ tweetId: z.ZodString }>, unknown> = {
    name: "twitter_delete",
    description: "Delete a tweet you authored. Requires the tweet id.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "delete"],
    inputSchema: z.object({ tweetId: z.string().min(1) }),
    async execute({ tweetId }) {
      return client.request<unknown>(`/tweets/${encodeURIComponent(tweetId)}`, { method: "DELETE" });
    },
  };

  const search: ToolDef<z.ZodObject<{ query: z.ZodString; maxResults: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "twitter_search",
    description: "Search recent tweets (last 7 days). Supports X search operators (from:, lang:, is:retweet, etc).",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "search"],
    inputSchema: z.object({
      query: z.string().min(1).max(512),
      // X/Twitter API hard floor is 10, hard ceiling is 100. Default 20.
      maxResults: z.number().int().min(10).max(100).optional()
        .describe("Number of tweets to return. X API requires min 10, max 100. Default 20."),
    }),
    async execute({ query, maxResults }) {
      const q = new URLSearchParams({
        query,
        "tweet.fields": "author_id,created_at,public_metrics,lang",
        max_results: String(maxResults ?? 20),
      });
      return client.request<unknown>(`/tweets/search/recent?${q.toString()}`);
    },
  };

  const timeline: ToolDef<z.ZodObject<{ userId: z.ZodOptional<z.ZodString>; maxResults: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "twitter_timeline",
    description: "Fetch the authenticated user's (or another user's) recent timeline tweets.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "timeline"],
    inputSchema: z.object({
      userId: z.string().optional(),
      maxResults: z.number().int().min(5).max(100).optional(),
    }),
    async execute({ userId, maxResults }) {
      const id = userId ?? (await client.meId());
      const q = new URLSearchParams({
        "tweet.fields": "author_id,created_at,public_metrics",
        max_results: String(maxResults ?? 20),
      });
      return client.request<unknown>(`/users/${id}/tweets?${q.toString()}`);
    },
  };

  const mentions: ToolDef<z.ZodObject<{ maxResults: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "twitter_mentions",
    description: "List tweets mentioning the authenticated user. Useful for engagement workflows.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "mentions"],
    inputSchema: z.object({ maxResults: z.number().int().min(5).max(100).optional() }),
    async execute({ maxResults }) {
      const id = await client.meId();
      const q = new URLSearchParams({
        "tweet.fields": "author_id,created_at,public_metrics",
        max_results: String(maxResults ?? 20),
      });
      return client.request<unknown>(`/users/${id}/mentions?${q.toString()}`);
    },
  };

  const like: ToolDef<z.ZodObject<{ tweetId: z.ZodString }>, unknown> = {
    name: "twitter_like",
    description: "Like a tweet.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "like"],
    inputSchema: z.object({ tweetId: z.string().min(1) }),
    async execute({ tweetId }) {
      const id = await client.meId();
      return client.request<unknown>(`/users/${id}/likes`, {
        method: "POST",
        body: JSON.stringify({ tweet_id: tweetId }),
      });
    },
  };

  const unlike: ToolDef<z.ZodObject<{ tweetId: z.ZodString }>, unknown> = {
    name: "twitter_unlike",
    description: "Remove a like from a tweet.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "like"],
    inputSchema: z.object({ tweetId: z.string().min(1) }),
    async execute({ tweetId }) {
      const id = await client.meId();
      return client.request<unknown>(
        `/users/${id}/likes/${encodeURIComponent(tweetId)}`,
        { method: "DELETE" },
      );
    },
  };

  const retweet: ToolDef<z.ZodObject<{ tweetId: z.ZodString }>, unknown> = {
    name: "twitter_retweet",
    description: "Retweet a tweet.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "retweet"],
    inputSchema: z.object({ tweetId: z.string().min(1) }),
    async execute({ tweetId }) {
      const id = await client.meId();
      return client.request<unknown>(`/users/${id}/retweets`, {
        method: "POST",
        body: JSON.stringify({ tweet_id: tweetId }),
      });
    },
  };

  const follow: ToolDef<z.ZodObject<{ userId: z.ZodString }>, unknown> = {
    name: "twitter_follow",
    description: "Follow another X user by their numeric user id.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "follow"],
    inputSchema: z.object({ userId: z.string().min(1) }),
    async execute({ userId }) {
      const id = await client.meId();
      return client.request<unknown>(`/users/${id}/following`, {
        method: "POST",
        body: JSON.stringify({ target_user_id: userId }),
      });
    },
  };

  const lookupUser: ToolDef<z.ZodObject<{ username: z.ZodString }>, unknown> = {
    name: "twitter_lookup_user",
    description: "Resolve a @username to a user object (id, name, metrics, verified).",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "user"],
    inputSchema: z.object({ username: z.string().min(1).max(80) }),
    async execute({ username }) {
      const clean = username.replace(/^@/, "");
      const q = new URLSearchParams({ "user.fields": "created_at,description,public_metrics,verified" });
      return client.request<unknown>(`/users/by/username/${encodeURIComponent(clean)}?${q.toString()}`);
    },
  };

  const unretweet: ToolDef<z.ZodObject<{ tweetId: z.ZodString }>, unknown> = {
    name: "twitter_unretweet",
    description: "Undo a retweet.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "retweet"],
    inputSchema: z.object({ tweetId: z.string().min(1) }),
    async execute({ tweetId }) {
      const id = await client.meId();
      return client.request<unknown>(
        `/users/${id}/retweets/${encodeURIComponent(tweetId)}`,
        { method: "DELETE" },
      );
    },
  };

  const unfollow: ToolDef<z.ZodObject<{ userId: z.ZodString }>, unknown> = {
    name: "twitter_unfollow",
    description: "Unfollow a user by numeric id.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "follow"],
    inputSchema: z.object({ userId: z.string().min(1) }),
    async execute({ userId }) {
      const id = await client.meId();
      return client.request<unknown>(
        `/users/${id}/following/${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      );
    },
  };

  const listFollowers: ToolDef<z.ZodObject<{ userId: z.ZodOptional<z.ZodString>; maxResults: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "twitter_list_followers",
    description: "List followers of a user (defaults to the authenticated user).",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "follow"],
    inputSchema: z.object({
      userId: z.string().optional(),
      maxResults: z.number().int().min(1).max(1000).optional(),
    }),
    async execute({ userId, maxResults }) {
      const id = userId ?? (await client.meId());
      const q = new URLSearchParams({ max_results: String(maxResults ?? 100) });
      return client.request<unknown>(`/users/${id}/followers?${q.toString()}`);
    },
  };

  const listFollowing: ToolDef<z.ZodObject<{ userId: z.ZodOptional<z.ZodString>; maxResults: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "twitter_list_following",
    description: "List who a user is following (defaults to the authenticated user).",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "follow"],
    inputSchema: z.object({
      userId: z.string().optional(),
      maxResults: z.number().int().min(1).max(1000).optional(),
    }),
    async execute({ userId, maxResults }) {
      const id = userId ?? (await client.meId());
      const q = new URLSearchParams({ max_results: String(maxResults ?? 100) });
      return client.request<unknown>(`/users/${id}/following?${q.toString()}`);
    },
  };

  const bookmark: ToolDef<z.ZodObject<{ tweetId: z.ZodString }>, unknown> = {
    name: "twitter_bookmark",
    description: "Bookmark a tweet for later reference.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "bookmark"],
    inputSchema: z.object({ tweetId: z.string().min(1) }),
    async execute({ tweetId }) {
      const id = await client.meId();
      return client.request<unknown>(`/users/${id}/bookmarks`, {
        method: "POST",
        body: JSON.stringify({ tweet_id: tweetId }),
      });
    },
  };

  const unbookmark: ToolDef<z.ZodObject<{ tweetId: z.ZodString }>, unknown> = {
    name: "twitter_unbookmark",
    description: "Remove a tweet from bookmarks.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "bookmark"],
    inputSchema: z.object({ tweetId: z.string().min(1) }),
    async execute({ tweetId }) {
      const id = await client.meId();
      return client.request<unknown>(
        `/users/${id}/bookmarks/${encodeURIComponent(tweetId)}`,
        { method: "DELETE" },
      );
    },
  };

  const dmSend: ToolDef<z.ZodObject<{ recipientId: z.ZodString; text: z.ZodString }>, unknown> = {
    name: "twitter_dm_send",
    description: "Send a direct message to another user by their numeric id. Starts a new DM conversation or appends to an existing one.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "dm"],
    inputSchema: z.object({
      recipientId: z.string().min(1),
      text: z.string().min(1).max(10_000),
    }),
    async execute({ recipientId, text }) {
      return client.request<unknown>(
        `/dm_conversations/with/${encodeURIComponent(recipientId)}/messages`,
        {
          method: "POST",
          body: JSON.stringify({ text }),
        },
      );
    },
  };

  const listAddMember: ToolDef<z.ZodObject<{ listId: z.ZodString; userId: z.ZodString }>, unknown> = {
    name: "twitter_list_add_member",
    description: "Add a user to a Twitter List you own.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "list"],
    inputSchema: z.object({ listId: z.string().min(1), userId: z.string().min(1) }),
    async execute({ listId, userId }) {
      return client.request<unknown>(
        `/lists/${encodeURIComponent(listId)}/members`,
        {
          method: "POST",
          body: JSON.stringify({ user_id: userId }),
        },
      );
    },
  };

  const listRemoveMember: ToolDef<z.ZodObject<{ listId: z.ZodString; userId: z.ZodString }>, unknown> = {
    name: "twitter_list_remove_member",
    description: "Remove a user from a Twitter List you own.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "list"],
    inputSchema: z.object({ listId: z.string().min(1), userId: z.string().min(1) }),
    async execute({ listId, userId }) {
      return client.request<unknown>(
        `/lists/${encodeURIComponent(listId)}/members/${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      );
    },
  };

  const block: ToolDef<z.ZodObject<{ userId: z.ZodString }>, unknown> = {
    name: "twitter_block",
    description: "Block a user by numeric id.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "block"],
    inputSchema: z.object({ userId: z.string().min(1) }),
    async execute({ userId }) {
      const id = await client.meId();
      return client.request<unknown>(`/users/${id}/blocking`, {
        method: "POST",
        body: JSON.stringify({ target_user_id: userId }),
      });
    },
  };

  const unblock: ToolDef<z.ZodObject<{ userId: z.ZodString }>, unknown> = {
    name: "twitter_unblock",
    description: "Unblock a user.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "block"],
    inputSchema: z.object({ userId: z.string().min(1) }),
    async execute({ userId }) {
      const id = await client.meId();
      return client.request<unknown>(
        `/users/${id}/blocking/${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      );
    },
  };

  const mute: ToolDef<z.ZodObject<{ userId: z.ZodString }>, unknown> = {
    name: "twitter_mute",
    description: "Mute a user — their posts won't appear in your timeline.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "mute"],
    inputSchema: z.object({ userId: z.string().min(1) }),
    async execute({ userId }) {
      const id = await client.meId();
      return client.request<unknown>(`/users/${id}/muting`, {
        method: "POST",
        body: JSON.stringify({ target_user_id: userId }),
      });
    },
  };

  const unmute: ToolDef<z.ZodObject<{ userId: z.ZodString }>, unknown> = {
    name: "twitter_unmute",
    description: "Unmute a user.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "mute"],
    inputSchema: z.object({ userId: z.string().min(1) }),
    async execute({ userId }) {
      const id = await client.meId();
      return client.request<unknown>(
        `/users/${id}/muting/${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      );
    },
  };

  const hideReply: ToolDef<z.ZodObject<{ tweetId: z.ZodString; hidden: z.ZodOptional<z.ZodBoolean> }>, unknown> = {
    name: "twitter_hide_reply",
    description: "Hide (or unhide) a reply to one of your tweets. Only the original author can hide replies.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "moderate"],
    inputSchema: z.object({
      tweetId: z.string().min(1),
      hidden: z.boolean().optional(),
    }),
    async execute({ tweetId, hidden }) {
      return client.request<unknown>(
        `/tweets/${encodeURIComponent(tweetId)}/hidden`,
        {
          method: "PUT",
          body: JSON.stringify({ hidden: hidden ?? true }),
        },
      );
    },
  };

  const createList: ToolDef<z.ZodObject<{ name: z.ZodString; description: z.ZodOptional<z.ZodString>; private: z.ZodOptional<z.ZodBoolean> }>, unknown> = {
    name: "twitter_list_create",
    description: "Create a new Twitter List.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "list"],
    inputSchema: z.object({
      name: z.string().min(1).max(25),
      description: z.string().max(100).optional(),
      private: z.boolean().optional(),
    }),
    async execute({ name, description, private: isPrivate }) {
      return client.request<unknown>("/lists", {
        method: "POST",
        body: JSON.stringify({
          name,
          ...(description ? { description } : {}),
          ...(isPrivate !== undefined ? { private: isPrivate } : {}),
        }),
      });
    },
  };

  const deleteList: ToolDef<z.ZodObject<{ listId: z.ZodString }>, unknown> = {
    name: "twitter_list_delete",
    description: "Delete a Twitter List you own.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "list"],
    inputSchema: z.object({ listId: z.string().min(1) }),
    async execute({ listId }) {
      return client.request<unknown>(
        `/lists/${encodeURIComponent(listId)}`,
        { method: "DELETE" },
      );
    },
  };

  const updateList: ToolDef<z.ZodObject<{ listId: z.ZodString; name: z.ZodOptional<z.ZodString>; description: z.ZodOptional<z.ZodString>; private: z.ZodOptional<z.ZodBoolean> }>, unknown> = {
    name: "twitter_list_update",
    description: "Update name, description, or privacy on a Twitter List you own.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "list"],
    inputSchema: z.object({
      listId: z.string().min(1),
      name: z.string().max(25).optional(),
      description: z.string().max(100).optional(),
      private: z.boolean().optional(),
    }),
    async execute({ listId, name, description, private: isPrivate }) {
      const body: Record<string, unknown> = {};
      if (name !== undefined) body["name"] = name;
      if (description !== undefined) body["description"] = description;
      if (isPrivate !== undefined) body["private"] = isPrivate;
      return client.request<unknown>(
        `/lists/${encodeURIComponent(listId)}`,
        { method: "PUT", body: JSON.stringify(body) },
      );
    },
  };

  const getList: ToolDef<z.ZodObject<{ listId: z.ZodString }>, unknown> = {
    name: "twitter_list_get",
    description: "Fetch a Twitter List by id.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "list"],
    inputSchema: z.object({ listId: z.string().min(1) }),
    async execute({ listId }) {
      const q = new URLSearchParams({ "list.fields": "created_at,description,member_count,follower_count,private,owner_id" });
      return client.request<unknown>(
        `/lists/${encodeURIComponent(listId)}?${q.toString()}`,
      );
    },
  };

  const getListMembers: ToolDef<z.ZodObject<{ listId: z.ZodString; maxResults: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "twitter_list_members",
    description: "List the members of a Twitter List.",
    category: "channel",
    source: { kind: "core" },
    tags: ["twitter", "list"],
    inputSchema: z.object({
      listId: z.string().min(1),
      maxResults: z.number().int().min(1).max(100).optional(),
    }),
    async execute({ listId, maxResults }) {
      const q = new URLSearchParams({ max_results: String(maxResults ?? 100) });
      return client.request<unknown>(
        `/lists/${encodeURIComponent(listId)}/members?${q.toString()}`,
      );
    },
  };

  return [
    post, del, search, timeline, mentions, like, unlike, retweet, unretweet,
    follow, unfollow, listFollowers, listFollowing, bookmark, unbookmark,
    block, unblock, mute, unmute, hideReply,
    dmSend, lookupUser,
    listAddMember, listRemoveMember, createList, deleteList, updateList, getList, getListMembers,
  ] as unknown as readonly ToolDef[];
}
