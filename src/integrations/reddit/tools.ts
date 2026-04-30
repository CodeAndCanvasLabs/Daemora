/**
 * Reddit tools exposed to the `reddit-crew`.
 *
 * Reddit's automation rules vary by subreddit — many ban LLM-written
 * content. The reddit-crew's system prompt owns the ToS guardrails;
 * these tools trust the crew to have checked subreddit rules before
 * calling anything that posts.
 *
 * Coverage from Reddit API docs:
 *   identity (me), subreddit search, subreddit listing, submit,
 *   comment, reply, vote, save/unsave, user posts, subscribe, inbox.
 */

import { z } from "zod";

import type { ToolDef } from "../../tools/types.js";
import type { IntegrationManager } from "../IntegrationManager.js";
import { RedditClient } from "./RedditClient.js";

export function makeRedditTools(integrations: IntegrationManager): readonly ToolDef[] {
  const client = new RedditClient(integrations);

  const me: ToolDef<z.ZodObject<Record<string, never>>, unknown> = {
    name: "reddit_me",
    description: "Return the authenticated user's profile (karma, created, verified email, is_mod).",
    category: "channel",
    source: { kind: "core" },
    tags: ["reddit", "user"],
    inputSchema: z.object({}),
    async execute() {
      return client.request<unknown>("/api/v1/me");
    },
  };

  const submit: ToolDef<z.ZodObject<{
    subreddit: z.ZodString;
    title: z.ZodString;
    kind: z.ZodEnum<["self", "link"]>;
    text: z.ZodOptional<z.ZodString>;
    url: z.ZodOptional<z.ZodString>;
    sendReplies: z.ZodOptional<z.ZodBoolean>;
    nsfw: z.ZodOptional<z.ZodBoolean>;
    spoiler: z.ZodOptional<z.ZodBoolean>;
    flairId: z.ZodOptional<z.ZodString>;
    flairText: z.ZodOptional<z.ZodString>;
  }>, unknown> = {
    name: "reddit_submit",
    description: "Submit a text (`kind=self`) or link (`kind=link`) post to a subreddit. CHECK subreddit rules and flair requirements before posting.",
    category: "channel",
    source: { kind: "core" },
    tags: ["reddit", "submit", "write"],
    inputSchema: z.object({
      subreddit: z.string().min(1).max(50),
      title: z.string().min(1).max(300),
      kind: z.enum(["self", "link"]),
      text: z.string().max(40_000).optional(),
      url: z.string().url().optional(),
      sendReplies: z.boolean().optional(),
      nsfw: z.boolean().optional(),
      spoiler: z.boolean().optional(),
      flairId: z.string().optional(),
      flairText: z.string().optional(),
    }),
    async execute(args) {
      const form: Record<string, string | number | boolean> = {
        api_type: "json",
        sr: args.subreddit,
        title: args.title,
        kind: args.kind,
      };
      if (args.kind === "self" && args.text) form["text"] = args.text;
      if (args.kind === "link" && args.url) form["url"] = args.url;
      if (args.sendReplies !== undefined) form["sendreplies"] = args.sendReplies;
      if (args.nsfw !== undefined) form["nsfw"] = args.nsfw;
      if (args.spoiler !== undefined) form["spoiler"] = args.spoiler;
      if (args.flairId) form["flair_id"] = args.flairId;
      if (args.flairText) form["flair_text"] = args.flairText;
      return client.form<unknown>("/api/submit", form);
    },
  };

  const comment: ToolDef<z.ZodObject<{
    parentFullname: z.ZodString;
    text: z.ZodString;
  }>, unknown> = {
    name: "reddit_comment",
    description: "Reply to a post or another comment. `parentFullname` is the thing-id (`t3_abc` for a post, `t1_abc` for a comment).",
    category: "channel",
    source: { kind: "core" },
    tags: ["reddit", "comment", "write"],
    inputSchema: z.object({
      parentFullname: z.string().min(1).max(24),
      text: z.string().min(1).max(10_000),
    }),
    async execute({ parentFullname, text }) {
      return client.form<unknown>("/api/comment", {
        api_type: "json",
        thing_id: parentFullname,
        text,
      });
    },
  };

  const vote: ToolDef<z.ZodObject<{
    fullname: z.ZodString;
    dir: z.ZodEnum<["up", "down", "clear"]>;
  }>, unknown> = {
    name: "reddit_vote",
    description: "Upvote / downvote / clear vote on a post or comment. Reddit's ToS forbids vote manipulation — only vote on content you've read.",
    category: "channel",
    source: { kind: "core" },
    tags: ["reddit", "vote"],
    inputSchema: z.object({
      fullname: z.string().min(1),
      dir: z.enum(["up", "down", "clear"]),
    }),
    async execute({ fullname, dir }) {
      const d = dir === "up" ? 1 : dir === "down" ? -1 : 0;
      return client.form<unknown>("/api/vote", { id: fullname, dir: d });
    },
  };

  const save: ToolDef<z.ZodObject<{ fullname: z.ZodString }>, unknown> = {
    name: "reddit_save",
    description: "Save a post or comment to your account's saved list.",
    category: "channel",
    source: { kind: "core" },
    tags: ["reddit", "save"],
    inputSchema: z.object({ fullname: z.string().min(1) }),
    async execute({ fullname }) {
      return client.form<unknown>("/api/save", { id: fullname });
    },
  };

  const unsave: ToolDef<z.ZodObject<{ fullname: z.ZodString }>, unknown> = {
    name: "reddit_unsave",
    description: "Remove a saved post or comment.",
    category: "channel",
    source: { kind: "core" },
    tags: ["reddit", "save"],
    inputSchema: z.object({ fullname: z.string().min(1) }),
    async execute({ fullname }) {
      return client.form<unknown>("/api/unsave", { id: fullname });
    },
  };

  const del: ToolDef<z.ZodObject<{ fullname: z.ZodString }>, unknown> = {
    name: "reddit_delete",
    description: "Delete a post or comment you authored.",
    category: "channel",
    source: { kind: "core" },
    tags: ["reddit", "delete"],
    inputSchema: z.object({ fullname: z.string().min(1) }),
    async execute({ fullname }) {
      return client.form<unknown>("/api/del", { id: fullname });
    },
  };

  const edit: ToolDef<z.ZodObject<{ fullname: z.ZodString; text: z.ZodString }>, unknown> = {
    name: "reddit_edit",
    description: "Edit the body of a self-post or comment you authored.",
    category: "channel",
    source: { kind: "core" },
    tags: ["reddit", "edit"],
    inputSchema: z.object({
      fullname: z.string().min(1),
      text: z.string().min(1).max(40_000),
    }),
    async execute({ fullname, text }) {
      return client.form<unknown>("/api/editusertext", {
        api_type: "json",
        thing_id: fullname,
        text,
      });
    },
  };

  const subredditListing: ToolDef<z.ZodObject<{
    subreddit: z.ZodString;
    listing: z.ZodEnum<["hot", "new", "top", "rising"]>;
    limit: z.ZodOptional<z.ZodNumber>;
    t: z.ZodOptional<z.ZodEnum<["hour", "day", "week", "month", "year", "all"]>>;
  }>, unknown> = {
    name: "reddit_subreddit_listing",
    description: "Fetch a subreddit's hot / new / top / rising listing. `t` narrows top by window.",
    category: "channel",
    source: { kind: "core" },
    tags: ["reddit", "read"],
    inputSchema: z.object({
      subreddit: z.string().min(1).max(50),
      listing: z.enum(["hot", "new", "top", "rising"]),
      limit: z.number().int().min(1).max(100).optional(),
      t: z.enum(["hour", "day", "week", "month", "year", "all"]).optional(),
    }),
    async execute({ subreddit, listing, limit, t }) {
      const q = new URLSearchParams();
      if (limit) q.set("limit", String(limit));
      if (t) q.set("t", t);
      return client.request<unknown>(`/r/${encodeURIComponent(subreddit)}/${listing}?${q.toString()}`);
    },
  };

  const search: ToolDef<z.ZodObject<{
    query: z.ZodString;
    subreddit: z.ZodOptional<z.ZodString>;
    sort: z.ZodOptional<z.ZodEnum<["relevance", "hot", "top", "new", "comments"]>>;
    t: z.ZodOptional<z.ZodEnum<["hour", "day", "week", "month", "year", "all"]>>;
    limit: z.ZodOptional<z.ZodNumber>;
  }>, unknown> = {
    name: "reddit_search",
    description: "Search posts. Scope to a subreddit with `subreddit`; use Reddit search operators in `query` (author:, self:yes, nsfw:no).",
    category: "channel",
    source: { kind: "core" },
    tags: ["reddit", "search"],
    inputSchema: z.object({
      query: z.string().min(1).max(512),
      subreddit: z.string().optional(),
      sort: z.enum(["relevance", "hot", "top", "new", "comments"]).optional(),
      t: z.enum(["hour", "day", "week", "month", "year", "all"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async execute({ query, subreddit, sort, t, limit }) {
      const q = new URLSearchParams({ q: query });
      if (sort) q.set("sort", sort);
      if (t) q.set("t", t);
      if (limit) q.set("limit", String(limit));
      if (subreddit) q.set("restrict_sr", "on");
      const path = subreddit ? `/r/${encodeURIComponent(subreddit)}/search` : "/search";
      return client.request<unknown>(`${path}?${q.toString()}`);
    },
  };

  const subscribe: ToolDef<z.ZodObject<{
    subreddit: z.ZodString;
    action: z.ZodEnum<["sub", "unsub"]>;
  }>, unknown> = {
    name: "reddit_subscribe",
    description: "Subscribe or unsubscribe from a subreddit.",
    category: "channel",
    source: { kind: "core" },
    tags: ["reddit", "subscribe"],
    inputSchema: z.object({
      subreddit: z.string().min(1).max(50),
      action: z.enum(["sub", "unsub"]),
    }),
    async execute({ subreddit, action }) {
      return client.form<unknown>("/api/subscribe", {
        action,
        sr_name: subreddit,
      });
    },
  };

  const mySubreddits: ToolDef<z.ZodObject<{ limit: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "reddit_my_subreddits",
    description: "List subreddits the authenticated user is subscribed to.",
    category: "channel",
    source: { kind: "core" },
    tags: ["reddit", "read"],
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    async execute({ limit }) {
      const q = new URLSearchParams();
      if (limit) q.set("limit", String(limit));
      return client.request<unknown>(`/subreddits/mine/subscriber?${q.toString()}`);
    },
  };

  const userPosts: ToolDef<z.ZodObject<{
    username: z.ZodString;
    kind: z.ZodEnum<["submitted", "comments", "overview"]>;
    limit: z.ZodOptional<z.ZodNumber>;
  }>, unknown> = {
    name: "reddit_user_posts",
    description: "Fetch posts/comments by a user. `kind=overview` returns both interleaved.",
    category: "channel",
    source: { kind: "core" },
    tags: ["reddit", "read"],
    inputSchema: z.object({
      username: z.string().min(1).max(40),
      kind: z.enum(["submitted", "comments", "overview"]),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async execute({ username, kind, limit }) {
      const q = new URLSearchParams();
      if (limit) q.set("limit", String(limit));
      const clean = username.replace(/^u\//i, "");
      return client.request<unknown>(`/user/${encodeURIComponent(clean)}/${kind}?${q.toString()}`);
    },
  };

  const inbox: ToolDef<z.ZodObject<{
    kind: z.ZodEnum<["inbox", "unread", "messages", "mentions", "sent"]>;
    limit: z.ZodOptional<z.ZodNumber>;
  }>, unknown> = {
    name: "reddit_inbox",
    description: "List the authenticated user's messages / mentions / replies.",
    category: "channel",
    source: { kind: "core" },
    tags: ["reddit", "inbox"],
    inputSchema: z.object({
      kind: z.enum(["inbox", "unread", "messages", "mentions", "sent"]),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async execute({ kind, limit }) {
      const q = new URLSearchParams();
      if (limit) q.set("limit", String(limit));
      return client.request<unknown>(`/message/${kind}?${q.toString()}`);
    },
  };

  const report: ToolDef<z.ZodObject<{ fullname: z.ZodString; reason: z.ZodString }>, unknown> = {
    name: "reddit_report",
    description: "Report a post or comment to the subreddit's mods. Always include a specific reason.",
    category: "channel",
    source: { kind: "core" },
    tags: ["reddit", "report"],
    inputSchema: z.object({
      fullname: z.string().min(1),
      reason: z.string().min(1).max(100),
    }),
    async execute({ fullname, reason }) {
      return client.form<unknown>("/api/report", {
        api_type: "json",
        thing_id: fullname,
        reason,
      });
    },
  };

  return [
    me, submit, comment, edit, del, vote, save, unsave,
    subredditListing, search, subscribe, mySubreddits, userPosts,
    inbox, report,
  ] as unknown as readonly ToolDef[];
}
