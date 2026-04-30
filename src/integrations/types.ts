/**
 * Integration primitives — shared types for OAuth-backed integrations
 * (Twitter, YouTube, Facebook, Instagram).
 *
 * The shapes here are what IntegrationStore persists and what each
 * provider's client code consumes. Keep them stable — other modules
 * (API clients, tool definitions, crew manifests) depend on them.
 */

export type ProviderId =
  | "twitter"
  | "google"
  | "meta"
  | "github"
  | "notion"
  | "reddit"
  | "linkedin"
  | "tiktok";

/**
 * Logical "integration" the user interacts with in Settings — multiple
 * integrations can share one OAuth provider (Facebook + Instagram both
 * use "meta"; YouTube + Gmail + Google Calendar all ride "google").
 */
export type IntegrationId =
  | "twitter"
  | "youtube"
  | "facebook"
  | "instagram"
  | "github"
  | "notion"
  | "gmail"
  | "google_calendar"
  | "reddit"
  | "linkedin"
  | "tiktok";

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Unix seconds. 0 means the token has no declared expiry. */
  readonly expiresAt: number;
  readonly scopes: readonly string[];
  /** Provider-returned account identifier (Twitter user id, Google sub, Meta user id). */
  readonly accountId: string;
  /** Human label — @handle, channel title, page name. Shown in UI. */
  readonly accountLabel: string;
  /** Raw provider response, stashed for debugging / future use. */
  readonly raw?: Record<string, unknown>;
}

export interface IntegrationAccount {
  readonly integration: IntegrationId;
  readonly provider: ProviderId;
  readonly accountId: string;
  readonly accountLabel: string;
  readonly scopes: readonly string[];
  /** Unix ms. */
  readonly connectedAt: number;
  /** Unix seconds; 0 when unknown. */
  readonly expiresAt: number;
}

export interface StartAuthArgs {
  readonly redirectUri: string;
  readonly state: string;
  readonly pkceVerifier?: string;
  readonly extraScopes?: readonly string[];
}

export interface ExchangeArgs {
  readonly code: string;
  readonly redirectUri: string;
  readonly pkceVerifier?: string;
}

/**
 * OAuthProvider — one impl per OAuth server (not per integration).
 * The provider layer knows how to authorize / exchange / refresh; each
 * integration chooses scopes + account labeling on top.
 */
export interface OAuthProvider {
  readonly id: ProviderId;
  /** Does this provider use PKCE? (Twitter: yes; Google: yes; Meta: no) */
  readonly usesPKCE: boolean;
  /** Build the authorize URL the user is redirected to. */
  authorizeUrl(args: StartAuthArgs & { scopes: readonly string[]; clientId: string }): string;
  /** Exchange the returned code for tokens. Account label is filled in by the caller. */
  exchangeCode(args: ExchangeArgs & { clientId: string; clientSecret?: string }): Promise<TokenSet>;
  /** Refresh an access token. Throws if refresh isn't possible. */
  refresh(args: { refreshToken: string; clientId: string; clientSecret?: string }): Promise<TokenSet>;
}

/** Bundled OAuth app credentials (Daemora's registered apps). */
export interface IntegrationAppKeys {
  /**
   * Twitter / X. PKCE is always required. `clientSecret` is optional — it
   * is ONLY supplied when the X app is registered as a "Confidential
   * client" in the X developer portal, in which case the token endpoint
   * also expects HTTP Basic auth. Public clients leave it undefined.
   */
  readonly twitter: { readonly clientId: string; readonly clientSecret?: string } | null;
  readonly google: { readonly clientId: string; readonly clientSecret: string } | null;
  readonly meta: { readonly appId: string; readonly appSecret: string } | null;
  readonly github: { readonly clientId: string; readonly clientSecret: string } | null;
  readonly notion: { readonly clientId: string; readonly clientSecret: string } | null;
  readonly reddit: { readonly clientId: string; readonly clientSecret: string } | null;
  readonly linkedin: { readonly clientId: string; readonly clientSecret: string } | null;
  readonly tiktok: { readonly clientKey: string; readonly clientSecret: string } | null;
}
