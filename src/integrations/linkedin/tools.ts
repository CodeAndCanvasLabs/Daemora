/**
 * LinkedIn tools exposed to the `linkedin-crew`.
 *
 * Scope: personal-feed write + read. Company-page / Marketing-Platform
 * endpoints are not included because they require Partner status.
 *
 * Coverage:
 *   userinfo, text share, article share, delete share, read share,
 *   like, unlike, comment on share.
 */

import { z } from "zod";

import type { ToolDef } from "../../tools/types.js";
import type { IntegrationManager } from "../IntegrationManager.js";
import { LinkedInClient } from "./LinkedInClient.js";

export function makeLinkedInTools(integrations: IntegrationManager): readonly ToolDef[] {
  const client = new LinkedInClient(integrations);

  const me: ToolDef<z.ZodObject<Record<string, never>>, unknown> = {
    name: "linkedin_me",
    description: "Return the authenticated user's profile (name, email, sub/urn).",
    category: "channel",
    source: { kind: "core" },
    tags: ["linkedin", "user"],
    inputSchema: z.object({}),
    async execute() {
      return client.request<unknown>("/v2/userinfo");
    },
  };

  const shareText: ToolDef<z.ZodObject<{
    text: z.ZodString;
    visibility: z.ZodOptional<z.ZodEnum<["PUBLIC", "CONNECTIONS"]>>;
  }>, unknown> = {
    name: "linkedin_share_text",
    description: "Publish a text-only post to the authenticated user's feed.",
    category: "channel",
    source: { kind: "core" },
    tags: ["linkedin", "post"],
    inputSchema: z.object({
      text: z.string().min(1).max(3000),
      visibility: z.enum(["PUBLIC", "CONNECTIONS"]).optional(),
    }),
    async execute({ text, visibility }) {
      const author = await client.personUrn();
      return client.request<unknown>("/v2/ugcPosts", {
        method: "POST",
        body: JSON.stringify({
          author,
          lifecycleState: "PUBLISHED",
          specificContent: {
            "com.linkedin.ugc.ShareContent": {
              shareCommentary: { text },
              shareMediaCategory: "NONE",
            },
          },
          visibility: {
            "com.linkedin.ugc.MemberNetworkVisibility": visibility ?? "PUBLIC",
          },
        }),
      });
    },
  };

  const shareArticle: ToolDef<z.ZodObject<{
    text: z.ZodString;
    articleUrl: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    visibility: z.ZodOptional<z.ZodEnum<["PUBLIC", "CONNECTIONS"]>>;
  }>, unknown> = {
    name: "linkedin_share_article",
    description: "Publish a post that links to an article / external URL with optional title & description.",
    category: "channel",
    source: { kind: "core" },
    tags: ["linkedin", "post", "article"],
    inputSchema: z.object({
      text: z.string().min(1).max(3000),
      articleUrl: z.string().url(),
      title: z.string().optional(),
      description: z.string().optional(),
      visibility: z.enum(["PUBLIC", "CONNECTIONS"]).optional(),
    }),
    async execute({ text, articleUrl, title, description, visibility }) {
      const author = await client.personUrn();
      return client.request<unknown>("/v2/ugcPosts", {
        method: "POST",
        body: JSON.stringify({
          author,
          lifecycleState: "PUBLISHED",
          specificContent: {
            "com.linkedin.ugc.ShareContent": {
              shareCommentary: { text },
              shareMediaCategory: "ARTICLE",
              media: [{
                status: "READY",
                originalUrl: articleUrl,
                ...(title ? { title: { text: title } } : {}),
                ...(description ? { description: { text: description } } : {}),
              }],
            },
          },
          visibility: {
            "com.linkedin.ugc.MemberNetworkVisibility": visibility ?? "PUBLIC",
          },
        }),
      });
    },
  };

  const deleteShare: ToolDef<z.ZodObject<{ shareUrn: z.ZodString }>, unknown> = {
    name: "linkedin_delete_share",
    description: "Delete a post you authored. `shareUrn` is the full URN (e.g. urn:li:share:1234).",
    category: "channel",
    source: { kind: "core" },
    tags: ["linkedin", "delete"],
    inputSchema: z.object({ shareUrn: z.string().min(1) }),
    async execute({ shareUrn }) {
      return client.request<unknown>(`/v2/ugcPosts/${encodeURIComponent(shareUrn)}`, { method: "DELETE" });
    },
  };

  const getShare: ToolDef<z.ZodObject<{ shareUrn: z.ZodString }>, unknown> = {
    name: "linkedin_get_share",
    description: "Fetch a UGC post by its URN.",
    category: "channel",
    source: { kind: "core" },
    tags: ["linkedin", "read"],
    inputSchema: z.object({ shareUrn: z.string().min(1) }),
    async execute({ shareUrn }) {
      return client.request<unknown>(`/v2/ugcPosts/${encodeURIComponent(shareUrn)}`);
    },
  };

  const commentOnShare: ToolDef<z.ZodObject<{
    shareUrn: z.ZodString;
    text: z.ZodString;
  }>, unknown> = {
    name: "linkedin_comment",
    description: "Comment on a UGC post (your own or a colleague's) by its URN.",
    category: "channel",
    source: { kind: "core" },
    tags: ["linkedin", "comment"],
    inputSchema: z.object({
      shareUrn: z.string().min(1),
      text: z.string().min(1).max(1250),
    }),
    async execute({ shareUrn, text }) {
      const actor = await client.personUrn();
      return client.request<unknown>(`/v2/socialActions/${encodeURIComponent(shareUrn)}/comments`, {
        method: "POST",
        body: JSON.stringify({ actor, message: { text } }),
      });
    },
  };

  const likeShare: ToolDef<z.ZodObject<{ shareUrn: z.ZodString }>, unknown> = {
    name: "linkedin_like",
    description: "Like a UGC post.",
    category: "channel",
    source: { kind: "core" },
    tags: ["linkedin", "like"],
    inputSchema: z.object({ shareUrn: z.string().min(1) }),
    async execute({ shareUrn }) {
      const actor = await client.personUrn();
      return client.request<unknown>(`/v2/socialActions/${encodeURIComponent(shareUrn)}/likes`, {
        method: "POST",
        body: JSON.stringify({ actor, object: shareUrn }),
      });
    },
  };

  return [
    me, shareText, shareArticle, deleteShare, getShare, commentOnShare, likeShare,
  ] as unknown as readonly ToolDef[];
}
