/**
 * IntegrationWatcher — polls an integration's API for new items and
 * fires the host watcher when anything shows up that wasn't there on
 * the previous poll.
 *
 * Supported events (selected by `event` config):
 *   twitter / mention         — authenticated user's mentions feed
 *   twitter / search          — recent search query
 *   twitter / new_follower    — authenticated user's follower list delta
 *   youtube / new_video       — uploads on a channel (mine:true or channelId)
 *   youtube / new_comment     — comments across your videos (or one video)
 *   facebook / new_page_post  — posts on one of the user's Pages
 *   facebook / new_comment    — comments on a Page's posts
 *   instagram / new_media     — new media on an IG Business account
 *   instagram / new_comment   — new comments on an IG Business account's media
 *
 * Diff strategy mirrors PollWatcher: hash the list of item ids; the
 * first poll seeds state and does NOT fire (avoids a trigger storm
 * on restart); subsequent polls fire once per NEW id observed.
 *
 * Auth + refresh is handled by the integration's client, so a revoked
 * token auto-recovers via the retry-on-401 wrapper without the watcher
 * noticing.
 */

import { createLogger } from "../util/logger.js";
import { CalendarClient } from "../integrations/google-calendar/CalendarClient.js";
import { FacebookClient } from "../integrations/facebook/FacebookClient.js";
import { GmailClient } from "../integrations/gmail/GmailClient.js";
import { InstagramClient } from "../integrations/instagram/InstagramClient.js";
import { LinkedInClient } from "../integrations/linkedin/LinkedInClient.js";
import { RedditClient } from "../integrations/reddit/RedditClient.js";
import { TikTokClient } from "../integrations/tiktok/TikTokClient.js";
import { TwitterClient } from "../integrations/twitter/TwitterClient.js";
import { YouTubeClient } from "../integrations/youtube/YouTubeClient.js";
import { authFetch } from "../integrations/authFetch.js";
import type { IntegrationManager } from "../integrations/IntegrationManager.js";
import type { IntegrationId } from "../integrations/types.js";

const log = createLogger("watcher.integration");

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const MIN_INTERVAL_MS = 30_000;

export type IntegrationEvent =
  | "mention"
  | "search"
  | "new_follower"
  | "new_video"
  | "new_comment"
  | "new_page_post"
  | "new_media"
  | "new_email"
  | "new_event"
  | "event_starting_soon"
  | "subreddit_new"
  | "new_mention_reddit"
  | "new_inbox_item"
  | "new_issue"
  | "new_pull_request"
  | "new_release"
  | "new_commit"
  | "new_post_comment"
  | "new_video_comment";

export interface IntegrationWatcherConfig {
  readonly integration: IntegrationId;
  readonly event: IntegrationEvent;
  readonly intervalMs?: number;
  /** Free-form params per event — query for search, channelId for YT, etc. */
  readonly params?: Record<string, string>;
}

export interface IntegrationWatcherFireEvent {
  readonly integration: IntegrationId;
  readonly event: IntegrationEvent;
  /** The newly-observed item (exact shape depends on integration + event). */
  readonly item: unknown;
}

export type IntegrationWatcherCallback = (ev: IntegrationWatcherFireEvent) => void;

export class IntegrationWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** Item ids observed on the last poll. First poll seeds this only. */
  private seen = new Set<string>();
  private seeded = false;
  private readonly intervalMs: number;
  private readonly twitter: TwitterClient;
  private readonly youtube: YouTubeClient;
  private readonly facebook: FacebookClient;
  private readonly instagram: InstagramClient;
  private readonly gmail: GmailClient;
  private readonly calendar: CalendarClient;
  private readonly reddit: RedditClient;
  private readonly linkedin: LinkedInClient;
  private readonly tiktok: TikTokClient;

  constructor(
    private readonly integrations: IntegrationManager,
    private readonly config: IntegrationWatcherConfig,
    private readonly onFire: IntegrationWatcherCallback,
  ) {
    const requested = config.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.intervalMs = Math.max(MIN_INTERVAL_MS, requested);
    this.twitter = new TwitterClient(integrations);
    this.youtube = new YouTubeClient(integrations);
    this.facebook = new FacebookClient(integrations);
    this.instagram = new InstagramClient(integrations);
    this.gmail = new GmailClient(integrations);
    this.calendar = new CalendarClient(integrations);
    this.reddit = new RedditClient(integrations);
    this.linkedin = new LinkedInClient(integrations);
    this.tiktok = new TikTokClient(integrations);
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.polling = false;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const items = await this.fetchItems();
      const ids = new Set(items.map((i) => i.id));
      if (!this.seeded) {
        this.seen = ids;
        this.seeded = true;
        return;
      }
      const fresh = items.filter((i) => !this.seen.has(i.id));
      this.seen = ids;
      for (const item of fresh) {
        this.onFire({
          integration: this.config.integration,
          event: this.config.event,
          item: item.raw,
        });
      }
    } catch (e) {
      log.warn(
        { integration: this.config.integration, event: this.config.event, err: (e as Error).message },
        "integration poll failed",
      );
    } finally {
      this.polling = false;
    }
  }

  /** Fetch and normalize the current snapshot to a list of {id, raw}. */
  private async fetchItems(): Promise<Array<{ id: string; raw: unknown }>> {
    const { integration, event, params = {} } = this.config;
    if (integration === "twitter") {
      if (event === "mention") {
        const body = await this.twitter.request<{ data?: Array<{ id: string }> }>(
          `/users/${await this.twitter.meId()}/mentions?max_results=50&tweet.fields=author_id,created_at`,
        );
        return (body.data ?? []).map((t) => ({ id: t.id, raw: t }));
      }
      if (event === "search") {
        const q = params["query"];
        if (!q) throw new Error("twitter search watcher: params.query required");
        const body = await this.twitter.request<{ data?: Array<{ id: string }> }>(
          `/tweets/search/recent?max_results=50&query=${encodeURIComponent(q)}&tweet.fields=author_id,created_at`,
        );
        return (body.data ?? []).map((t) => ({ id: t.id, raw: t }));
      }
      if (event === "new_follower") {
        const me = await this.twitter.meId();
        const body = await this.twitter.request<{ data?: Array<{ id: string }> }>(
          `/users/${me}/followers?max_results=100`,
        );
        return (body.data ?? []).map((u) => ({ id: u.id, raw: u }));
      }
    }

    if (integration === "youtube") {
      if (event === "new_video") {
        const channelId = params["channelId"];
        const q = channelId
          ? `part=snippet&channelId=${encodeURIComponent(channelId)}&order=date&type=video&maxResults=25`
          : `part=snippet&forMine=true&type=video&order=date&maxResults=25`;
        const body = await this.youtube.request<{ items?: Array<{ id: { videoId?: string } }> }>(
          `/search?${q}`,
        );
        return (body.items ?? [])
          .filter((it) => it.id.videoId)
          .map((it) => ({ id: it.id.videoId!, raw: it }));
      }
      if (event === "new_comment") {
        const videoId = params["videoId"];
        if (!videoId) throw new Error("youtube new_comment watcher: params.videoId required");
        const body = await this.youtube.request<{ items?: Array<{ id: string }> }>(
          `/commentThreads?part=snippet&videoId=${encodeURIComponent(videoId)}&maxResults=50&order=time`,
        );
        return (body.items ?? []).map((it) => ({ id: it.id, raw: it }));
      }
    }

    if (integration === "facebook") {
      const pageId = params["pageId"];
      if (!pageId) throw new Error(`facebook ${event} watcher: params.pageId required`);
      const token = await this.facebook.pageToken(pageId);
      if (event === "new_page_post") {
        const body = await this.facebook.request<{ data?: Array<{ id: string }> }>(
          `/${pageId}/posts?fields=id,message,created_time&limit=25`,
          {},
          token,
        );
        return (body.data ?? []).map((p) => ({ id: p.id, raw: p }));
      }
      if (event === "new_comment") {
        // Comments live under each post — walk the first page of
        // recent posts and union their comment ids.
        const posts = await this.facebook.request<{ data?: Array<{ id: string }> }>(
          `/${pageId}/posts?fields=id&limit=10`,
          {},
          token,
        );
        const out: Array<{ id: string; raw: unknown }> = [];
        for (const p of posts.data ?? []) {
          const comments = await this.facebook.request<{ data?: Array<{ id: string }> }>(
            `/${p.id}/comments?fields=id,from,message,created_time&limit=25`,
            {},
            token,
          );
          for (const c of comments.data ?? []) out.push({ id: c.id, raw: { postId: p.id, ...c } });
        }
        return out;
      }
    }

    if (integration === "instagram") {
      const igUserId = params["igUserId"];
      if (!igUserId) throw new Error(`instagram ${event} watcher: params.igUserId required`);
      if (event === "new_media") {
        const token = await this.instagram.tokenForIgUser(igUserId);
        const body = await this.instagram.raw<{ data?: Array<{ id: string }> }>(
          `/${igUserId}/media?fields=id,caption,media_type,permalink,timestamp&limit=25`,
          {},
          token,
        );
        return (body.data ?? []).map((m) => ({ id: m.id, raw: m }));
      }
      if (event === "new_comment") {
        const token = await this.instagram.tokenForIgUser(igUserId);
        const media = await this.instagram.raw<{ data?: Array<{ id: string }> }>(
          `/${igUserId}/media?fields=id&limit=10`,
          {},
          token,
        );
        const out: Array<{ id: string; raw: unknown }> = [];
        for (const m of media.data ?? []) {
          const comments = await this.instagram.raw<{ data?: Array<{ id: string }> }>(
            `/${m.id}/comments?fields=id,text,username,timestamp&limit=25`,
            {},
            token,
          );
          for (const c of comments.data ?? []) out.push({ id: c.id, raw: { mediaId: m.id, ...c } });
        }
        return out;
      }
    }

    if (integration === "gmail") {
      if (event === "new_email") {
        const q = params["query"] ?? "in:inbox is:unread";
        const body = await this.gmail.request<{ messages?: Array<{ id: string; threadId?: string }> }>(
          `/users/me/messages?maxResults=50&q=${encodeURIComponent(q)}`,
        );
        return (body.messages ?? []).map((m) => ({ id: m.id, raw: m }));
      }
    }

    if (integration === "google_calendar") {
      const calendarId = params["calendarId"] ?? "primary";
      if (event === "new_event") {
        // Query the updated window — events Google reported as modified
        // since "now"-ish. Pagination is ignored; 50 events per poll is
        // more than enough for any human calendar.
        const nowIso = new Date().toISOString();
        const q = new URLSearchParams({
          timeMin: nowIso,
          maxResults: "50",
          singleEvents: "true",
          orderBy: "startTime",
        });
        const body = await this.calendar.request<{ items?: Array<{ id: string }> }>(
          `/calendars/${encodeURIComponent(calendarId)}/events?${q.toString()}`,
        );
        return (body.items ?? []).map((it) => ({ id: it.id, raw: it }));
      }
      if (event === "event_starting_soon") {
        // Fires once per event that enters the "starts within N minutes"
        // window. Window minutes come from params.windowMinutes (default 15).
        const windowMin = Math.max(1, parseInt(params["windowMinutes"] ?? "15", 10) || 15);
        const now = Date.now();
        const windowEnd = new Date(now + windowMin * 60_000).toISOString();
        const q = new URLSearchParams({
          timeMin: new Date(now).toISOString(),
          timeMax: windowEnd,
          maxResults: "50",
          singleEvents: "true",
          orderBy: "startTime",
        });
        const body = await this.calendar.request<{ items?: Array<{ id: string }> }>(
          `/calendars/${encodeURIComponent(calendarId)}/events?${q.toString()}`,
        );
        return (body.items ?? []).map((it) => ({ id: it.id, raw: it }));
      }
    }

    if (integration === "reddit") {
      if (event === "subreddit_new") {
        const sr = params["subreddit"];
        if (!sr) throw new Error("reddit subreddit_new watcher: params.subreddit required");
        const limit = params["limit"] ?? "25";
        const body = await this.reddit.request<{ data?: { children?: Array<{ data: { name: string } }> } }>(
          `/r/${encodeURIComponent(sr)}/new?limit=${encodeURIComponent(limit)}`,
        );
        return (body.data?.children ?? []).map((c) => ({ id: c.data.name, raw: c.data }));
      }
      if (event === "new_mention_reddit") {
        const body = await this.reddit.request<{ data?: { children?: Array<{ data: { name: string } }> } }>(
          `/message/mentions?limit=50`,
        );
        return (body.data?.children ?? []).map((c) => ({ id: c.data.name, raw: c.data }));
      }
      if (event === "new_inbox_item") {
        const body = await this.reddit.request<{ data?: { children?: Array<{ data: { name: string } }> } }>(
          `/message/inbox?limit=50`,
        );
        return (body.data?.children ?? []).map((c) => ({ id: c.data.name, raw: c.data }));
      }
    }

    if (integration === "github") {
      // GitHub integration is served by the remote MCP server, but
      // polling uses the same OAuth token directly against api.github.com
      // so we don't depend on MCP for event discovery.
      const ghFetch = async <T>(path: string): Promise<T> => {
        const resp = await authFetch(this.integrations, "github", (token) =>
          fetch(`https://api.github.com${path}`, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "daemora",
            },
          }),
        );
        if (!resp.ok) throw new Error(`GitHub ${resp.status} ${path}`);
        return resp.json() as Promise<T>;
      };

      if (event === "new_issue") {
        const repo = params["repo"];
        if (!repo) throw new Error("github new_issue watcher: params.repo (owner/name) required");
        const items = await ghFetch<Array<{ id: number; number: number; pull_request?: unknown }>>(
          `/repos/${repo}/issues?state=open&per_page=50&sort=created&direction=desc`,
        );
        // The issues endpoint includes PRs — filter them out so a
        // new_issue watcher doesn't fire on PR activity.
        return items
          .filter((it) => !it.pull_request)
          .map((it) => ({ id: `${repo}#${it.number}`, raw: it }));
      }
      if (event === "new_pull_request") {
        const repo = params["repo"];
        if (!repo) throw new Error("github new_pull_request watcher: params.repo (owner/name) required");
        const items = await ghFetch<Array<{ id: number; number: number }>>(
          `/repos/${repo}/pulls?state=open&per_page=50&sort=created&direction=desc`,
        );
        return items.map((pr) => ({ id: `${repo}#${pr.number}`, raw: pr }));
      }
      if (event === "new_release") {
        const repo = params["repo"];
        if (!repo) throw new Error("github new_release watcher: params.repo (owner/name) required");
        const items = await ghFetch<Array<{ id: number; tag_name: string }>>(
          `/repos/${repo}/releases?per_page=25`,
        );
        return items.map((r) => ({ id: `${repo}@${r.tag_name}`, raw: r }));
      }
      if (event === "new_commit") {
        const repo = params["repo"];
        if (!repo) throw new Error("github new_commit watcher: params.repo (owner/name) required");
        const branch = params["branch"];
        const q = new URLSearchParams({ per_page: "25" });
        if (branch) q.set("sha", branch);
        const items = await ghFetch<Array<{ sha: string }>>(
          `/repos/${repo}/commits?${q.toString()}`,
        );
        return items.map((c) => ({ id: `${repo}@${c.sha}`, raw: c }));
      }
    }

    if (integration === "linkedin") {
      if (event === "new_post_comment") {
        const shareUrn = params["shareUrn"];
        if (!shareUrn) throw new Error("linkedin new_post_comment watcher: params.shareUrn required");
        const body = await this.linkedin.request<{ elements?: Array<{ id?: string; created?: { time?: number } }> }>(
          `/v2/socialActions/${encodeURIComponent(shareUrn)}/comments?count=50`,
        );
        return (body.elements ?? [])
          .filter((c): c is { id: string } => typeof c.id === "string")
          .map((c) => ({ id: c.id, raw: c }));
      }
    }

    if (integration === "tiktok") {
      if (event === "new_video_comment") {
        const videoId = params["videoId"];
        if (!videoId) throw new Error("tiktok new_video_comment watcher: params.videoId required");
        const body = await this.tiktok.request<{ data?: { comments?: Array<{ comment_id: string }> } }>(
          "/v2/video/comment/list/",
          {
            method: "POST",
            body: JSON.stringify({ video_id: videoId, max_count: 50 }),
          },
        );
        return (body.data?.comments ?? []).map((c) => ({ id: c.comment_id, raw: c }));
      }
      if (event === "new_follower") {
        // TikTok doesn't expose a followers list endpoint on the
        // public Open API — we proxy the count field from user/info
        // and fire whenever it increases. The "id" is just the current
        // count string so a stable count doesn't fire, but an increase
        // registers once.
        const body = await this.tiktok.request<{ data?: { user?: { follower_count?: number } } }>(
          "/v2/user/info/?fields=follower_count",
        );
        const count = body.data?.user?.follower_count ?? 0;
        return [{ id: `follower_count:${count}`, raw: { follower_count: count } }];
      }
    }

    throw new Error(`Unsupported integration watcher: ${integration}/${event}`);
  }
}
