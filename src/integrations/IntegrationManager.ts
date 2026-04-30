/**
 * IntegrationManager — orchestrates OAuth flows for all integrations.
 *
 * Surfaces:
 *   startAuth(integration, redirectUri)  → { url, state }
 *   completeAuth(state, code)             → { integration, accountLabel }
 *   getAccessToken(integration, accountId?) → string    (auto-refreshes)
 *   disconnect(integration, accountId)
 *   listAccounts(integration?)
 *   availability()                        → which integrations have working creds
 *
 * Pending auth state (the code-verifier + integration id we expect back
 * at callback) lives in an in-memory map keyed by `state`. Entries
 * expire after 10 minutes.
 */

import { EventEmitter } from "node:events";

import { createLogger } from "../util/logger.js";
import type { ConfigManager } from "../config/ConfigManager.js";
import { ProviderError, ValidationError } from "../util/errors.js";
import { readExtraScopes, resolveIntegrationKeys } from "./keys.js";
import { generatePKCE, generateState } from "./pkce.js";
import { githubProvider } from "./providers/github.js";
import { googleProvider } from "./providers/google.js";
import { linkedinProvider } from "./providers/linkedin.js";
import { metaProvider } from "./providers/meta.js";
import { notionProvider } from "./providers/notion.js";
import { redditProvider } from "./providers/reddit.js";
import { tiktokProvider } from "./providers/tiktok.js";
import { twitterProvider } from "./providers/twitter.js";
import type { IntegrationStore } from "./IntegrationStore.js";
import type { IntegrationAccount, IntegrationId, OAuthProvider, ProviderId, TokenSet } from "./types.js";

const log = createLogger("integrations.manager");

/**
 * When `getAccessToken` is called and the stored token has less than
 * this long remaining, we transparently refresh before returning.
 * Short enough that UI requests don't wait on a refresh they could
 * have avoided; long enough that API calls hitting on-expiry get a
 * fresh token the first time.
 */
const EXPIRY_BUFFER_SECONDS = 5 * 60;

/**
 * Background refresher poll cadence + pre-expiry window. Every
 * BG_TICK_MS we scan connected accounts and refresh any with less
 * than BG_PRE_EXPIRY_SECONDS remaining. This keeps access tokens
 * warm so interactive requests never pay the refresh cost.
 *
 * Buffer must exceed the cadence — otherwise a token can expire
 * mid-cycle and the next sweep finds it already dead. With 30 min
 * cadence + 35 min buffer, even Google's 1 h access token gets
 * refreshed at minute ~25-30 of its life, well before expiry.
 */
const BG_TICK_MS = 30 * 60_000;
const BG_PRE_EXPIRY_SECONDS = 35 * 60;

/** Pending auth states live 10 min. */
const PENDING_TTL_MS = 10 * 60_000;

interface PendingAuth {
  readonly integration: IntegrationId;
  readonly provider: ProviderId;
  readonly redirectUri: string;
  readonly pkceVerifier?: string;
  readonly createdAt: number;
}

/**
 * Integration → OAuth provider + default scope list. The integration id
 * is the user-facing name; multiple integrations can share one
 * provider (facebook + instagram both ride Meta).
 */
const INTEGRATION_CONFIG: Record<IntegrationId, {
  provider: ProviderId;
  scopes: readonly string[];
}> = {
  twitter: {
    provider: "twitter",
    scopes: [
      "tweet.read", "tweet.write", "users.read",
      "follows.read", "follows.write",
      "like.read", "like.write",
      "offline.access",
    ],
  },
  youtube: {
    provider: "google",
    scopes: [
      "https://www.googleapis.com/auth/youtube",
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/youtube.force-ssl",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  },
  gmail: {
    provider: "google",
    scopes: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  },
  google_calendar: {
    provider: "google",
    scopes: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  },
  github: {
    provider: "github",
    scopes: ["repo", "workflow", "read:org", "gist", "user", "read:packages"],
  },
  notion: {
    // Notion's OAuth doesn't take scopes — access is gated by the pages
    // the user explicitly shares with the integration at consent time.
    provider: "notion",
    scopes: [],
  },
  reddit: {
    provider: "reddit",
    scopes: [
      "identity",
      "read",
      "submit",
      "edit",
      "history",
      "mysubreddits",
      "vote",
      "save",
      "subscribe",
      "report",
    ],
  },
  linkedin: {
    provider: "linkedin",
    // OpenID scopes + UGC share (post to own feed). Company-page /
    // marketing-platform scopes (w_organization_social, r_ads_reporting)
    // require Marketing Partner status and aren't requested by default.
    scopes: ["openid", "profile", "email", "w_member_social"],
  },
  tiktok: {
    provider: "tiktok",
    // Full TikTok scope set covering the products daemora actually uses.
    // Each scope requires its corresponding "Product" to be enabled on
    // the app in the developer portal — a request with even ONE scope
    // whose product isn't enabled is rejected wholesale (`invalid_scope`).
    //
    // Mapping (enable each Product in TikTok portal → /apps/<id> → "Add products"):
    //
    //   user.info.basic                       ← Login Kit
    //   user.info.profile, user.info.stats    ← User Information API
    //   video.list                            ← Video Management API
    //   video.upload, video.publish           ← Content Posting API
    //   comment.list, comment.list.manage     ← Comment Management API
    //
    // video.publish requires TikTok app audit; before audit, uploaded
    // videos are forced to SELF_ONLY visibility. video.upload covers
    // the draft-only flow that works pre-audit.
    // Default = the scope set most TikTok sandbox apps have available
    // out of the box once they add Login Kit + Content Posting API +
    // User Information API (the three sandbox-eligible products).
    // Anything beyond requires extra products in the portal AND will
    // be rejected with `invalid_scope` if missing — paste extras into
    // the Extra Scopes field once the matching product is added:
    //
    //   video.list                            ← Video Management API
    //   comment.list, comment.list.manage     ← Comment Management API
    //   research.adlib.basic, research.data.basic ← Research API
    scopes: [
      "user.info.basic",
      "user.info.profile",
      "user.info.stats",
      "video.upload",
      "video.publish",
    ],
  },
  facebook: {
    provider: "meta",
    scopes: [
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
      "pages_manage_engagement",
      "pages_messaging",
      "public_profile",
      "email",
    ],
  },
  instagram: {
    provider: "meta",
    scopes: [
      "instagram_basic",
      "instagram_content_publish",
      "instagram_manage_comments",
      "instagram_manage_insights",
      "pages_show_list",
      "pages_read_engagement",
    ],
  },
};

const PROVIDERS: Record<ProviderId, OAuthProvider> = {
  twitter: twitterProvider,
  google: googleProvider,
  meta: metaProvider,
  github: githubProvider,
  notion: notionProvider,
  reddit: redditProvider,
  linkedin: linkedinProvider,
  tiktok: tiktokProvider,
};

/**
 * Events:
 *   "connected"    { integration, account } — fires when a new auth completes.
 *   "disconnected" { integration, accountId } — fires on disconnect.
 * Listeners register / unregister the corresponding crew + watcher types.
 */
export class IntegrationManager extends EventEmitter {
  private readonly pending = new Map<string, PendingAuth>();
  /**
   * In-flight refresh deduplication. Keyed by "integration:accountId".
   * When two concurrent getAccessToken calls both need a refresh, the
   * second awaits the first's promise instead of firing a duplicate
   * exchange against the provider (Google issues at most one fresh
   * refresh_token per consent — racing breaks that).
   */
  private readonly refreshInflight = new Map<string, Promise<string | null>>();
  /**
   * Track integrations we've logged a "refresh failed — reconnect
   * needed" for, so we don't spam logs every call while the user
   * hasn't reconnected yet. Cleared when a refresh succeeds.
   */
  private readonly refreshFailures = new Map<string, number>();
  /** Last time we logged the "vault locked, skipping" warning, in ms epoch. */
  private lastLockedWarnAt = 0;
  /**
   * One-shot per-account timers for tokens whose lifetime is shorter
   * than the 30-min sweep cadence. Without these, a fresh token with
   * a 10-min TTL would expire 20 min before the next sweep notices.
   * Keyed by "integration:accountId"; replaced on every refresh.
   */
  private readonly earlyRefreshTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly cfg: ConfigManager,
    private readonly store: IntegrationStore,
  ) {
    super();
    // Best-effort GC for stale pending flows.
    const gc = setInterval(() => this.sweepPending(), 60_000);
    gc.unref?.();
    // Background refresher — keeps tokens warm well before they
    // expire so interactive requests never pay the refresh latency.
    const bg = setInterval(() => void this.backgroundRefresh(), BG_TICK_MS);
    bg.unref?.();
    // Vault-locked at boot is the silent failure mode: bg-refresh
    // skips every tick while locked, then the user unlocks via the UI
    // an hour later and finds every token expired. Re-firing on the
    // unlock event closes that gap. Mirrors the channel-startup hook
    // in src/cli/commands/start.ts.
    this.cfg.vault.on("unlocked", () => {
      void this.backgroundRefresh();
    });
  }

  /** Resolve the OAuth provider an integration rides (e.g. youtube/gmail → google). */
  providerFor(integration: IntegrationId): ProviderId {
    const cfg = INTEGRATION_CONFIG[integration];
    if (!cfg) throw new ValidationError(`Unknown integration: ${integration}`);
    return cfg.provider;
  }

  /** Default OAuth scopes Daemora requests for this integration. Used by the UI credentials modal. */
  defaultScopesFor(integration: IntegrationId): readonly string[] {
    return INTEGRATION_CONFIG[integration]?.scopes ?? [];
  }

  /** Tell the UI which integrations actually have working client creds. */
  availability(): Record<IntegrationId, { available: boolean; reason?: string }> {
    const keys = resolveIntegrationKeys(this.cfg);
    const out = {} as Record<IntegrationId, { available: boolean; reason?: string }>;
    out.twitter = keys.twitter ? { available: true } : { available: false, reason: "TWITTER_CLIENT_ID not configured" };
    out.youtube = keys.google ? { available: true } : { available: false, reason: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured" };
    out.gmail = keys.google ? { available: true } : { available: false, reason: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured" };
    out.google_calendar = keys.google ? { available: true } : { available: false, reason: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured" };
    out.facebook = keys.meta ? { available: true } : { available: false, reason: "META_APP_ID / META_APP_SECRET not configured" };
    out.instagram = keys.meta ? { available: true } : { available: false, reason: "META_APP_ID / META_APP_SECRET not configured" };
    out.github = keys.github ? { available: true } : { available: false, reason: "GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET not configured" };
    out.notion = keys.notion ? { available: true } : { available: false, reason: "NOTION_CLIENT_ID / NOTION_CLIENT_SECRET not configured" };
    out.reddit = keys.reddit ? { available: true } : { available: false, reason: "REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET not configured" };
    out.linkedin = keys.linkedin ? { available: true } : { available: false, reason: "LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET not configured" };
    out.tiktok = keys.tiktok ? { available: true } : { available: false, reason: "TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET not configured" };
    return out;
  }

  /** Begin an OAuth flow; returns a URL to redirect the user to. */
  startAuth(integration: IntegrationId, redirectUri: string): { url: string; state: string } {
    const cfg = INTEGRATION_CONFIG[integration];
    if (!cfg) throw new ValidationError(`Unknown integration: ${integration}`);

    const keys = resolveIntegrationKeys(this.cfg);
    const { clientId } = requireClient(integration, cfg.provider, keys);
    const provider = PROVIDERS[cfg.provider];

    const state = generateState();
    const pkce = provider.usesPKCE ? generatePKCE() : null;
    // Dedup scopes: defaults + any user-added extras from the vault.
    const extras = readExtraScopes(this.cfg, integration);
    const mergedScopes = Array.from(new Set<string>([...cfg.scopes, ...extras]));
    const url = provider.authorizeUrl({
      clientId,
      redirectUri,
      state,
      scopes: mergedScopes,
      ...(pkce ? { pkceVerifier: pkce.verifier } : {}),
    });

    this.pending.set(state, {
      integration,
      provider: cfg.provider,
      redirectUri,
      ...(pkce ? { pkceVerifier: pkce.verifier } : {}),
      createdAt: Date.now(),
    });
    return { url, state };
  }

  /** Complete an OAuth flow. Called from the callback route. */
  async completeAuth(state: string, code: string): Promise<{ integration: IntegrationId; accountLabel: string }> {
    const entry = this.pending.get(state);
    if (!entry) throw new ValidationError("Invalid or expired auth state. Try connecting again.");
    this.pending.delete(state);

    const provider = PROVIDERS[entry.provider];
    const keys = resolveIntegrationKeys(this.cfg);
    const { clientId, clientSecret } = requireClient(entry.integration, entry.provider, keys);

    const tokens = await provider.exchangeCode({
      code,
      redirectUri: entry.redirectUri,
      ...(entry.pkceVerifier ? { pkceVerifier: entry.pkceVerifier } : {}),
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
    });

    if (!tokens.accountId) {
      throw new ProviderError(
        "Provider returned no account id — cannot persist connection.",
        entry.provider,
      );
    }

    this.store.upsert({ integration: entry.integration, provider: entry.provider, tokens });
    log.info({ integration: entry.integration, account: tokens.accountLabel }, "integration connected");

    const account: IntegrationAccount = {
      integration: entry.integration,
      provider: entry.provider,
      accountId: tokens.accountId,
      accountLabel: tokens.accountLabel,
      scopes: tokens.scopes,
      connectedAt: Date.now(),
      expiresAt: tokens.expiresAt,
    };
    this.emit("connected", { integration: entry.integration, account });
    // A token issued just now with TTL < 30 min would slip past the
    // background sweep — schedule a per-account timer to catch it.
    this.scheduleEarlyRefresh(entry.integration, tokens.accountId, tokens.expiresAt);
    return { integration: entry.integration, accountLabel: tokens.accountLabel };
  }

  /**
   * Return a valid access token for an integration, refreshing on-
   * demand if the stored one is near expiry. Returns null when the
   * user has never connected that integration.
   *
   * `force=true` ignores the expiry check and forces a refresh — used
   * by the retry-on-401 path in integration clients when the provider
   * rejects a token we thought was still valid (revoked, scopes
   * changed, etc).
   */
  async getAccessToken(
    integration: IntegrationId,
    accountId?: string,
    force = false,
  ): Promise<string | null> {
    const tokens = this.store.getTokens(integration, accountId);
    if (!tokens) return null;

    const now = Math.floor(Date.now() / 1000);
    const nearExpiry = tokens.expiresAt > 0 && tokens.expiresAt - now < EXPIRY_BUFFER_SECONDS;
    const needsRefresh = force || nearExpiry;
    if (!needsRefresh) return tokens.accessToken;
    if (!tokens.refreshToken) return tokens.accessToken;

    // Deduplicate concurrent refreshes — if two callers race, they
    // share the same promise so we don't burn a refresh_token twice.
    const key = `${integration}:${tokens.accountId}`;
    const existing = this.refreshInflight.get(key);
    if (existing) return existing;

    const job = this.doRefresh(integration, tokens).finally(() => {
      this.refreshInflight.delete(key);
    });
    this.refreshInflight.set(key, job);
    return job;
  }

  /**
   * Force a refresh for a specific account, bypassing the expiry
   * check. Used by integration clients on a 401 — the stored token
   * may have been revoked or invalidated independent of its expiry.
   * Returns the fresh access token or null if refresh failed.
   */
  async forceRefresh(integration: IntegrationId, accountId?: string): Promise<string | null> {
    return this.getAccessToken(integration, accountId, true);
  }

  private async doRefresh(integration: IntegrationId, tokens: TokenSet): Promise<string | null> {
    const cfg = INTEGRATION_CONFIG[integration];
    const provider = PROVIDERS[cfg.provider];
    const keys = resolveIntegrationKeys(this.cfg);
    const { clientId, clientSecret } = requireClient(integration, cfg.provider, keys);
    const key = `${integration}:${tokens.accountId}`;
    try {
      const refreshed = await provider.refresh({
        refreshToken: tokens.refreshToken!,
        clientId,
        ...(clientSecret ? { clientSecret } : {}),
      });
      // Providers vary on whether they return a fresh refresh_token
      // (Google often doesn't; Meta doesn't have one). Fall back to
      // the existing refresh credential when the response omits it.
      const carriedRefresh = refreshed.refreshToken ?? tokens.refreshToken;
      const merged: TokenSet = {
        ...refreshed,
        ...(carriedRefresh ? { refreshToken: carriedRefresh } : {}),
        accountId: tokens.accountId,
        accountLabel: tokens.accountLabel,
      };
      this.store.upsert({ integration, provider: cfg.provider, tokens: merged });
      this.refreshFailures.delete(key);
      this.emit("refreshed", { integration, accountId: tokens.accountId });
      // Reschedule the early-refresh timer against the new expiry so
      // back-to-back short-TTL tokens keep getting caught.
      this.scheduleEarlyRefresh(integration, tokens.accountId, merged.expiresAt);
      return merged.accessToken;
    } catch (e) {
      // Log once per failure window — spamming on every request hurts
      // log readability and doesn't give the user any new info.
      const lastLoggedAt = this.refreshFailures.get(key) ?? 0;
      if (Date.now() - lastLoggedAt > 60_000) {
        log.error({ integration, err: (e as Error).message }, "token refresh failed — user may need to reconnect");
        this.refreshFailures.set(key, Date.now());
      }
      this.emit("refresh-failed", { integration, accountId: tokens.accountId, error: (e as Error).message });
      // Return the stale token so the caller's 401-retry path can
      // surface a meaningful error to the user.
      return tokens.accessToken;
    }
  }

  /**
   * Background pass over every connected account, refreshing any
   * whose token expires in less than BG_PRE_EXPIRY_SECONDS. Called
   * every BG_TICK_MS from the constructor. Errors are swallowed —
   * the interactive path will retry.
   */
  private async backgroundRefresh(): Promise<void> {
    if (!this.cfg.vault.isUnlocked()) {
      // Throttled to one warning per cadence — without this the user
      // sees "refresh not working" with zero log evidence and has no
      // way to know the vault is the gate.
      const now = Date.now();
      if (now - this.lastLockedWarnAt > BG_TICK_MS - 1000) {
        log.warn("token refresh skipped — vault locked");
        this.lastLockedWarnAt = now;
      }
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const accounts = this.store.list();
    for (const a of accounts) {
      // Always (re)schedule the per-account early-refresh timer so a
      // fresh token whose TTL is shorter than the 30-min sweep window
      // gets refreshed before it expires. Cheap — at most one timer
      // per connected account.
      this.scheduleEarlyRefresh(a.integration, a.accountId, a.expiresAt);
      if (a.expiresAt === 0 || a.expiresAt - now > BG_PRE_EXPIRY_SECONDS) continue;
      try {
        await this.getAccessToken(a.integration, a.accountId);
      } catch { /* surfaced in doRefresh already */ }
    }
  }

  /**
   * Schedule a one-shot refresh that fires shortly before a specific
   * account's token expires. Cancels any prior timer for the same
   * account first. Skips when expiry is far enough out that the
   * BG_TICK_MS sweep will catch it; or when there's no expiry data.
   */
  private scheduleEarlyRefresh(
    integration: IntegrationId,
    accountId: string,
    expiresAt: number,
  ): void {
    const key = `${integration}:${accountId}`;
    const existing = this.earlyRefreshTimers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.earlyRefreshTimers.delete(key);
    }
    if (!expiresAt) return; // provider reports no expiry → nothing to schedule

    const nowSec = Math.floor(Date.now() / 1000);
    const secondsLeft = expiresAt - nowSec;
    // Refresh 60 s before actual expiry — enough headroom for the
    // exchange round-trip without burning the token's last seconds.
    const fireInSec = secondsLeft - 60;
    if (fireInSec <= 0) {
      // Already inside the safety margin (or past it) — refresh now.
      void this.getAccessToken(integration, accountId).catch(() => {});
      return;
    }
    // If the next regular sweep will catch it before our timer would
    // fire, don't bother — saves a setTimeout for the common case.
    if (fireInSec * 1000 >= BG_TICK_MS) return;

    const t = setTimeout(() => {
      this.earlyRefreshTimers.delete(key);
      void this.getAccessToken(integration, accountId).catch(() => {});
    }, fireInSec * 1000);
    t.unref?.();
    this.earlyRefreshTimers.set(key, t);
  }

  disconnect(integration: IntegrationId, accountId: string): void {
    this.store.remove(integration, accountId);
    const key = `${integration}:${accountId}`;
    const t = this.earlyRefreshTimers.get(key);
    if (t) {
      clearTimeout(t);
      this.earlyRefreshTimers.delete(key);
    }
    this.emit("disconnected", { integration, accountId });
  }

  /**
   * Set of integration ids that currently have at least one connected
   * account. Used by ToolRegistry.available() to gate integration-
   * sourced tools out of the model's view until the user connects.
   */
  getEnabled(): Set<string> {
    const out = new Set<string>();
    for (const a of this.store.list()) out.add(a.integration);
    return out;
  }

  listAccounts(integration?: IntegrationId) {
    return this.store.list(integration);
  }

  private sweepPending(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [state, entry] of this.pending) {
      if (entry.createdAt < cutoff) this.pending.delete(state);
    }
  }
}

function requireClient(
  integration: IntegrationId,
  provider: ProviderId,
  keys: ReturnType<typeof resolveIntegrationKeys>,
): { clientId: string; clientSecret?: string } {
  if (provider === "twitter") {
    if (!keys.twitter) throw new ValidationError(`${integration}: TWITTER_CLIENT_ID not configured.`);
    // clientSecret only present for Confidential client apps; spread
    // conditionally so the returned shape matches `clientSecret?: string`.
    return {
      clientId: keys.twitter.clientId,
      ...(keys.twitter.clientSecret ? { clientSecret: keys.twitter.clientSecret } : {}),
    };
  }
  if (provider === "google") {
    if (!keys.google) throw new ValidationError(`${integration}: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured.`);
    return { clientId: keys.google.clientId, clientSecret: keys.google.clientSecret };
  }
  if (provider === "meta") {
    if (!keys.meta) throw new ValidationError(`${integration}: META_APP_ID / META_APP_SECRET not configured.`);
    return { clientId: keys.meta.appId, clientSecret: keys.meta.appSecret };
  }
  if (provider === "github") {
    if (!keys.github) throw new ValidationError(`${integration}: GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET not configured.`);
    return { clientId: keys.github.clientId, clientSecret: keys.github.clientSecret };
  }
  if (provider === "notion") {
    if (!keys.notion) throw new ValidationError(`${integration}: NOTION_CLIENT_ID / NOTION_CLIENT_SECRET not configured.`);
    return { clientId: keys.notion.clientId, clientSecret: keys.notion.clientSecret };
  }
  if (provider === "reddit") {
    if (!keys.reddit) throw new ValidationError(`${integration}: REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET not configured.`);
    return { clientId: keys.reddit.clientId, clientSecret: keys.reddit.clientSecret };
  }
  if (provider === "linkedin") {
    if (!keys.linkedin) throw new ValidationError(`${integration}: LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET not configured.`);
    return { clientId: keys.linkedin.clientId, clientSecret: keys.linkedin.clientSecret };
  }
  if (provider === "tiktok") {
    if (!keys.tiktok) throw new ValidationError(`${integration}: TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET not configured.`);
    return { clientId: keys.tiktok.clientKey, clientSecret: keys.tiktok.clientSecret };
  }
  throw new ValidationError(`Unknown provider ${provider} for integration ${integration}`);
}
