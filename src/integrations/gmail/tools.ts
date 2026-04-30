/**
 * Gmail tool set exposed to the `gmail-crew`.
 *
 * Endpoint coverage mirrors n8n's GmailV2 node:
 *   send, reply, draft create, list messages, get, search,
 *   trash/untrash, delete, label CRUD, apply/remove label, thread get,
 *   markAsRead / markAsUnread.
 *
 * Auth flows through IntegrationManager → `gmail` integration.
 */

import { z } from "zod";

import type { ToolDef } from "../../tools/types.js";
import type { IntegrationManager } from "../IntegrationManager.js";
import { buildRawMessage, GmailClient } from "./GmailClient.js";

export function makeGmailTools(integrations: IntegrationManager): readonly ToolDef[] {
  const client = new GmailClient(integrations);

  const send: ToolDef<z.ZodObject<{
    to: z.ZodString;
    subject: z.ZodString;
    body: z.ZodString;
    cc: z.ZodOptional<z.ZodString>;
    bcc: z.ZodOptional<z.ZodString>;
    html: z.ZodOptional<z.ZodBoolean>;
  }>, unknown> = {
    name: "gmail_send",
    description: "Send an email from the authenticated Gmail account. Body is plain text unless `html=true`.",
    category: "channel",
    source: { kind: "core" },
    tags: ["gmail", "send"],
    inputSchema: z.object({
      to: z.string().email(),
      subject: z.string().min(1).max(998),
      body: z.string().min(1),
      cc: z.string().optional(),
      bcc: z.string().optional(),
      html: z.boolean().optional(),
    }),
    async execute(args) {
      const raw = buildRawMessage(args);
      return client.request<unknown>("/users/me/messages/send", {
        method: "POST",
        body: JSON.stringify({ raw }),
      });
    },
  };

  const reply: ToolDef<z.ZodObject<{
    threadId: z.ZodString;
    to: z.ZodString;
    subject: z.ZodString;
    body: z.ZodString;
    replyToMessageId: z.ZodOptional<z.ZodString>;
    html: z.ZodOptional<z.ZodBoolean>;
  }>, unknown> = {
    name: "gmail_reply",
    description: "Reply to an existing thread. Pass the threadId to keep the reply in the same conversation.",
    category: "channel",
    source: { kind: "core" },
    tags: ["gmail", "reply"],
    inputSchema: z.object({
      threadId: z.string().min(1),
      to: z.string().email(),
      subject: z.string().min(1),
      body: z.string().min(1),
      replyToMessageId: z.string().optional(),
      html: z.boolean().optional(),
    }),
    async execute({ threadId, ...rest }) {
      const raw = buildRawMessage(rest);
      return client.request<unknown>("/users/me/messages/send", {
        method: "POST",
        body: JSON.stringify({ raw, threadId }),
      });
    },
  };

  const draftCreate: ToolDef<z.ZodObject<{
    to: z.ZodString;
    subject: z.ZodString;
    body: z.ZodString;
    cc: z.ZodOptional<z.ZodString>;
    html: z.ZodOptional<z.ZodBoolean>;
  }>, unknown> = {
    name: "gmail_draft_create",
    description: "Save a draft in the Drafts folder without sending it.",
    category: "channel",
    source: { kind: "core" },
    tags: ["gmail", "draft"],
    inputSchema: z.object({
      to: z.string().email(),
      subject: z.string().min(1),
      body: z.string().min(1),
      cc: z.string().optional(),
      html: z.boolean().optional(),
    }),
    async execute(args) {
      const raw = buildRawMessage(args);
      return client.request<unknown>("/users/me/drafts", {
        method: "POST",
        body: JSON.stringify({ message: { raw } }),
      });
    },
  };

  const list: ToolDef<z.ZodObject<{
    query: z.ZodOptional<z.ZodString>;
    labelIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
    maxResults: z.ZodOptional<z.ZodNumber>;
  }>, unknown> = {
    name: "gmail_list",
    description: "List messages in the inbox. Supports Gmail search operators via `query` (e.g. `from:alice is:unread newer_than:7d`).",
    category: "channel",
    source: { kind: "core" },
    tags: ["gmail", "list"],
    inputSchema: z.object({
      query: z.string().optional(),
      labelIds: z.array(z.string()).optional(),
      maxResults: z.number().int().min(1).max(500).optional(),
    }),
    async execute({ query, labelIds, maxResults }) {
      const q = new URLSearchParams();
      if (query) q.set("q", query);
      if (maxResults) q.set("maxResults", String(maxResults));
      for (const l of labelIds ?? []) q.append("labelIds", l);
      return client.request<unknown>(`/users/me/messages?${q.toString()}`);
    },
  };

  const get: ToolDef<z.ZodObject<{ id: z.ZodString; format: z.ZodOptional<z.ZodEnum<["full", "metadata", "minimal", "raw"]>> }>, unknown> = {
    name: "gmail_get",
    description: "Fetch a message by id. `format=metadata` returns headers only (cheap); `full` returns headers + parsed body.",
    category: "channel",
    source: { kind: "core" },
    tags: ["gmail", "get"],
    inputSchema: z.object({
      id: z.string().min(1),
      format: z.enum(["full", "metadata", "minimal", "raw"]).optional(),
    }),
    async execute({ id, format }) {
      const q = new URLSearchParams();
      if (format) q.set("format", format);
      return client.request<unknown>(`/users/me/messages/${encodeURIComponent(id)}?${q.toString()}`);
    },
  };

  const search: ToolDef<z.ZodObject<{ query: z.ZodString; maxResults: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "gmail_search",
    description: "Search messages with Gmail search operators. Returns ids and threadIds — call gmail_get for bodies.",
    category: "channel",
    source: { kind: "core" },
    tags: ["gmail", "search"],
    inputSchema: z.object({
      query: z.string().min(1),
      maxResults: z.number().int().min(1).max(500).optional(),
    }),
    async execute({ query, maxResults }) {
      const q = new URLSearchParams({ q: query, maxResults: String(maxResults ?? 20) });
      return client.request<unknown>(`/users/me/messages?${q.toString()}`);
    },
  };

  const trash: ToolDef<z.ZodObject<{ id: z.ZodString }>, unknown> = {
    name: "gmail_trash",
    description: "Move a message to Trash. Reversible for 30 days.",
    category: "channel",
    source: { kind: "core" },
    tags: ["gmail", "trash"],
    inputSchema: z.object({ id: z.string().min(1) }),
    async execute({ id }) {
      return client.request<unknown>(`/users/me/messages/${encodeURIComponent(id)}/trash`, { method: "POST" });
    },
  };

  const untrash: ToolDef<z.ZodObject<{ id: z.ZodString }>, unknown> = {
    name: "gmail_untrash",
    description: "Restore a message from Trash.",
    category: "channel",
    source: { kind: "core" },
    tags: ["gmail", "untrash"],
    inputSchema: z.object({ id: z.string().min(1) }),
    async execute({ id }) {
      return client.request<unknown>(`/users/me/messages/${encodeURIComponent(id)}/untrash`, { method: "POST" });
    },
  };

  const del: ToolDef<z.ZodObject<{ id: z.ZodString }>, unknown> = {
    name: "gmail_delete",
    description: "PERMANENTLY delete a message (bypasses Trash). Irreversible — confirm with the user first.",
    category: "channel",
    source: { kind: "core" },
    tags: ["gmail", "delete"],
    inputSchema: z.object({ id: z.string().min(1) }),
    async execute({ id }) {
      return client.request<unknown>(`/users/me/messages/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  };

  const listLabels: ToolDef<z.ZodObject<Record<string, never>>, unknown> = {
    name: "gmail_list_labels",
    description: "List all labels (system + user) on the authenticated account.",
    category: "channel",
    source: { kind: "core" },
    tags: ["gmail", "label"],
    inputSchema: z.object({}),
    async execute() {
      return client.request<unknown>("/users/me/labels");
    },
  };

  const createLabel: ToolDef<z.ZodObject<{ name: z.ZodString }>, unknown> = {
    name: "gmail_label_create",
    description: "Create a new user label.",
    category: "channel",
    source: { kind: "core" },
    tags: ["gmail", "label"],
    inputSchema: z.object({ name: z.string().min(1).max(225) }),
    async execute({ name }) {
      return client.request<unknown>("/users/me/labels", {
        method: "POST",
        body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
      });
    },
  };

  const deleteLabel: ToolDef<z.ZodObject<{ id: z.ZodString }>, unknown> = {
    name: "gmail_label_delete",
    description: "Delete a user label. Does not delete the emails tagged with it.",
    category: "channel",
    source: { kind: "core" },
    tags: ["gmail", "label"],
    inputSchema: z.object({ id: z.string().min(1) }),
    async execute({ id }) {
      return client.request<unknown>(`/users/me/labels/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  };

  const modify: ToolDef<z.ZodObject<{
    id: z.ZodString;
    addLabelIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
    removeLabelIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
  }>, unknown> = {
    name: "gmail_modify_labels",
    description: "Add and/or remove labels on a message. Use UNREAD/INBOX/STARRED/TRASH as system label ids; user labels by their id.",
    category: "channel",
    source: { kind: "core" },
    tags: ["gmail", "label"],
    inputSchema: z.object({
      id: z.string().min(1),
      addLabelIds: z.array(z.string()).optional(),
      removeLabelIds: z.array(z.string()).optional(),
    }),
    async execute({ id, addLabelIds, removeLabelIds }) {
      return client.request<unknown>(`/users/me/messages/${encodeURIComponent(id)}/modify`, {
        method: "POST",
        body: JSON.stringify({
          ...(addLabelIds ? { addLabelIds } : {}),
          ...(removeLabelIds ? { removeLabelIds } : {}),
        }),
      });
    },
  };

  const markAsRead: ToolDef<z.ZodObject<{ id: z.ZodString }>, unknown> = {
    name: "gmail_mark_read",
    description: "Remove the UNREAD label from a message.",
    category: "channel",
    source: { kind: "core" },
    tags: ["gmail", "state"],
    inputSchema: z.object({ id: z.string().min(1) }),
    async execute({ id }) {
      return client.request<unknown>(`/users/me/messages/${encodeURIComponent(id)}/modify`, {
        method: "POST",
        body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
      });
    },
  };

  const markAsUnread: ToolDef<z.ZodObject<{ id: z.ZodString }>, unknown> = {
    name: "gmail_mark_unread",
    description: "Add the UNREAD label to a message.",
    category: "channel",
    source: { kind: "core" },
    tags: ["gmail", "state"],
    inputSchema: z.object({ id: z.string().min(1) }),
    async execute({ id }) {
      return client.request<unknown>(`/users/me/messages/${encodeURIComponent(id)}/modify`, {
        method: "POST",
        body: JSON.stringify({ addLabelIds: ["UNREAD"] }),
      });
    },
  };

  const threadGet: ToolDef<z.ZodObject<{ id: z.ZodString; format: z.ZodOptional<z.ZodEnum<["full", "metadata", "minimal"]>> }>, unknown> = {
    name: "gmail_thread_get",
    description: "Fetch every message in a thread.",
    category: "channel",
    source: { kind: "core" },
    tags: ["gmail", "thread"],
    inputSchema: z.object({
      id: z.string().min(1),
      format: z.enum(["full", "metadata", "minimal"]).optional(),
    }),
    async execute({ id, format }) {
      const q = new URLSearchParams();
      if (format) q.set("format", format);
      return client.request<unknown>(`/users/me/threads/${encodeURIComponent(id)}?${q.toString()}`);
    },
  };

  const threadList: ToolDef<z.ZodObject<{ query: z.ZodOptional<z.ZodString>; maxResults: z.ZodOptional<z.ZodNumber> }>, unknown> = {
    name: "gmail_thread_list",
    description: "List threads (conversations) with optional Gmail search query.",
    category: "channel",
    source: { kind: "core" },
    tags: ["gmail", "thread"],
    inputSchema: z.object({
      query: z.string().optional(),
      maxResults: z.number().int().min(1).max(500).optional(),
    }),
    async execute({ query, maxResults }) {
      const q = new URLSearchParams();
      if (query) q.set("q", query);
      if (maxResults) q.set("maxResults", String(maxResults));
      return client.request<unknown>(`/users/me/threads?${q.toString()}`);
    },
  };

  return [
    send, reply, draftCreate, list, get, search,
    trash, untrash, del,
    listLabels, createLabel, deleteLabel, modify, markAsRead, markAsUnread,
    threadGet, threadList,
  ] as unknown as readonly ToolDef[];
}
