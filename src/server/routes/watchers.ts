/**
 * Watchers API — CRUD for event watchers + template catalogue.
 *
 *   GET    /api/watchers              list all
 *   POST   /api/watchers              create (from template or raw)
 *   GET    /api/watchers/:id          fetch one
 *   PATCH  /api/watchers/:id          update fields
 *   DELETE /api/watchers/:id          remove
 *   GET    /api/watchers/templates    list pre-configured templates
 */

import type { Express, Request, Response } from "express";

import { WATCHER_TEMPLATES } from "../../webhooks/watcherTemplates.js";
import type { ServerDeps } from "../index.js";
import { buildWebhookUrls } from "../../tunnels/urls.js";

export function mountWatcherRoutes(app: Express, deps: ServerDeps): void {
  app.get("/api/watchers/templates", (_req, res) => {
    res.json({ templates: WATCHER_TEMPLATES });
  });

  // Catalogue of integration-backed events the poller supports,
  // filtered by the user's currently connected integrations so the UI
  // never surfaces a trigger we can't actually fire. Params are
  // described so the UI can render the right input fields.
  app.get("/api/watchers/integration-events", (_req, res) => {
    const connected = deps.integrations.getEnabled();
    const catalogue: Array<{
      integration: string;
      event: string;
      label: string;
      description: string;
      params: Array<{ key: string; label: string; required: boolean; hint?: string }>;
    }> = [
      { integration: "twitter", event: "mention", label: "New @mention", description: "Fires when the authenticated user is mentioned in a tweet.", params: [] },
      { integration: "twitter", event: "search", label: "Search match", description: "Fires on new tweets matching a query (supports operators).", params: [{ key: "query", label: "Search query", required: true, hint: "e.g. daemora OR #automation -is:retweet" }] },
      { integration: "twitter", event: "new_follower", label: "New follower", description: "Fires when a new user follows you.", params: [] },
      { integration: "youtube", event: "new_video", label: "New video on channel", description: "Fires when a new video is published on a channel.", params: [{ key: "channelId", label: "Channel ID", required: false, hint: "Leave blank for your own channel" }] },
      { integration: "youtube", event: "new_comment", label: "New comment on video", description: "Fires on new comments on a specific video.", params: [{ key: "videoId", label: "Video ID", required: true }] },
      { integration: "facebook", event: "new_page_post", label: "New post on page", description: "Fires when a new post is published on a Facebook page.", params: [{ key: "pageId", label: "Page ID", required: true }] },
      { integration: "facebook", event: "new_comment", label: "New comment on page", description: "Fires on new comments on any post in a page's feed.", params: [{ key: "pageId", label: "Page ID", required: true }] },
      { integration: "instagram", event: "new_media", label: "New media posted", description: "Fires when a new photo/video/carousel is published.", params: [{ key: "igUserId", label: "Instagram User ID", required: true }] },
      { integration: "instagram", event: "new_comment", label: "New comment on media", description: "Fires on new comments across the account's media.", params: [{ key: "igUserId", label: "Instagram User ID", required: true }] },
      { integration: "gmail", event: "new_email", label: "New email", description: "Fires when a new email matches the query (defaults to `in:inbox is:unread`).", params: [{ key: "query", label: "Gmail search query", required: false, hint: "e.g. from:boss@ OR label:vip -category:promotions" }] },
      { integration: "google_calendar", event: "new_event", label: "New calendar event", description: "Fires when a new event appears on the calendar (from now forward).", params: [{ key: "calendarId", label: "Calendar ID", required: false, hint: "Leave blank for primary calendar" }] },
      { integration: "google_calendar", event: "event_starting_soon", label: "Event starting soon", description: "Fires when an event starts within a window.", params: [{ key: "windowMinutes", label: "Minutes-before window", required: false, hint: "Default 15" }, { key: "calendarId", label: "Calendar ID", required: false, hint: "Leave blank for primary" }] },
      { integration: "reddit", event: "subreddit_new", label: "New post in subreddit", description: "Fires on new posts to a subreddit.", params: [{ key: "subreddit", label: "Subreddit (no r/ prefix)", required: true }, { key: "limit", label: "Max per poll", required: false, hint: "Default 25" }] },
      { integration: "reddit", event: "new_mention_reddit", label: "New u/ mention", description: "Fires when someone u-mentions you on Reddit.", params: [] },
      { integration: "reddit", event: "new_inbox_item", label: "New inbox message", description: "Fires on new inbox items (replies, DMs, mentions).", params: [] },
      { integration: "github", event: "new_issue", label: "New issue opened", description: "Fires when an open issue appears on a repo (excludes PRs).", params: [{ key: "repo", label: "Repository (owner/name)", required: true, hint: "e.g. vercel/next.js" }] },
      { integration: "github", event: "new_pull_request", label: "New pull request", description: "Fires when a new PR is opened on a repo.", params: [{ key: "repo", label: "Repository (owner/name)", required: true }] },
      { integration: "github", event: "new_release", label: "New release", description: "Fires when a repo publishes a new release.", params: [{ key: "repo", label: "Repository (owner/name)", required: true }] },
      { integration: "github", event: "new_commit", label: "New commit on branch", description: "Fires on new commits to a repo (optionally a specific branch).", params: [{ key: "repo", label: "Repository (owner/name)", required: true }, { key: "branch", label: "Branch", required: false, hint: "Default: repo's default branch" }] },
      { integration: "linkedin", event: "new_post_comment", label: "New comment on your post", description: "Fires when a user comments on one of your LinkedIn posts.", params: [{ key: "shareUrn", label: "Share URN", required: true, hint: "urn:li:share:… of the post to watch" }] },
      { integration: "tiktok", event: "new_video_comment", label: "New comment on video", description: "Fires on new comments on a specific TikTok video.", params: [{ key: "videoId", label: "Video ID", required: true }] },
      { integration: "tiktok", event: "new_follower", label: "Follower count increase", description: "Fires when the follower count ticks up (TikTok doesn't expose follower lists).", params: [] },
    ];
    const available = catalogue.filter((e) => connected.has(e.integration));
    const unavailable = catalogue
      .filter((e) => !connected.has(e.integration))
      .map((e) => ({ integration: e.integration, reason: "not_connected" }));
    res.json({ events: available, unavailableIntegrations: Array.from(new Set(unavailable.map((u) => u.integration))) });
  });

  app.get("/api/watchers", (_req, res) => {
    res.json({ watchers: deps.watchers.list() });
  });

  app.post("/api/watchers", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      name?: string;
      templateId?: string;
      channel?: string;
      action?: string;
      pattern?: Record<string, unknown>;
      cooldownSeconds?: number;
    };

    const template = body.templateId ? WATCHER_TEMPLATES.find((t) => t.id === body.templateId) : undefined;
    if (body.templateId && !template) {
      return res.status(404).json({ error: `Template "${body.templateId}" not found.` });
    }

    const name = body.name ?? template?.name;
    if (!name) return res.status(400).json({ error: "`name` is required." });

    const action = body.action ?? template?.action ?? "";
    const patternObj: Record<string, unknown> = {
      ...(template?.pattern ?? {}),
      ...(body.pattern ?? {}),
    };
    const cooldownSeconds = body.cooldownSeconds ?? template?.cooldownSeconds ?? 0;
    if (cooldownSeconds > 0) patternObj["__cooldownSeconds"] = cooldownSeconds;

    const triggerType = (body as { triggerType?: "webhook" | "file" | "poll" | "cron" | "integration" }).triggerType ?? "webhook";
    const row = deps.watchers.create({
      name,
      triggerType,
      action,
      pattern: JSON.stringify(patternObj),
      ...(body.channel ? { channel: body.channel } : {}),
    });
    deps.watcherRunner.reload();

    // For webhook triggers, issue fresh bearer + HMAC secret so the
    // caller can register the endpoint with a provider immediately.
    // Plaintexts are returned ONCE; the store keeps only hashes/cipher.
    let tokens: { bearer: string; hmacSecret: string } | undefined;
    let urls: ReturnType<typeof buildWebhookUrls> | undefined;
    if (triggerType === "webhook") {
      tokens = deps.webhookTokens.issue(row.id);
      urls = buildWebhookUrls(deps.getPublicUrl(), row.id);
    }
    res.status(201).json({ watcher: row, ...(tokens ? { tokens } : {}), ...(urls ? { urls } : {}) });
  });

  app.get("/api/watchers/:id", (req, res) => {
    const row = deps.watchers.get(req.params.id ?? "");
    if (!row) return res.status(404).json({ error: "Watcher not found." });
    res.json({ watcher: row });
  });

  app.patch("/api/watchers/:id", (req: Request, res: Response) => {
    const id = req.params.id ?? "";
    const body = (req.body ?? {}) as {
      name?: string;
      action?: string;
      channel?: string;
      pattern?: Record<string, unknown>;
      enabled?: boolean;
    };
    const patch = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.action !== undefined ? { action: body.action } : {}),
      ...(body.channel !== undefined ? { channel: body.channel } : {}),
      ...(body.pattern !== undefined ? { pattern: JSON.stringify(body.pattern) } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    };
    const ok = deps.watchers.update(id, patch);
    if (!ok) return res.status(404).json({ error: "Watcher not found." });
    deps.watcherRunner.reload();
    res.json({ watcher: deps.watchers.get(id) });
  });

  app.delete("/api/watchers/:id", (req, res) => {
    const id = req.params.id ?? "";
    const ok = deps.watchers.delete(id);
    if (!ok) return res.status(404).json({ error: "Watcher not found." });
    deps.webhookTokens.remove(id);
    deps.watcherRunner.reload();
    res.status(204).end();
  });

  // Rotate tokens — returns fresh plaintexts. Provider must be reconfigured.
  app.post("/api/watchers/:id/token", (req, res) => {
    const id = req.params.id ?? "";
    const row = deps.watchers.get(id);
    if (!row) return res.status(404).json({ error: "Watcher not found" });
    const tokens = deps.webhookTokens.issue(id);
    const urls = buildWebhookUrls(deps.getPublicUrl(), id);
    res.json({ tokens, urls });
  });

  // Revoke tokens — webhook endpoints for this watcher will 401 until re-issued.
  app.delete("/api/watchers/:id/token", (req, res) => {
    const id = req.params.id ?? "";
    const ok = deps.webhookTokens.revoke(id);
    if (!ok) return res.status(404).json({ error: "No active tokens for this watcher." });
    res.json({ ok: true });
  });
}
