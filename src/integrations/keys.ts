/**
 * Integration OAuth app credentials.
 *
 * Daemora ships with pre-registered OAuth apps for Twitter, Google
 * (YouTube), and Meta (Facebook + Instagram) so non-technical users can
 * click "Connect" without registering their own developer accounts. For
 * PKCE providers (Twitter, Google) the "secret" isn't really a secret —
 * the client_id is inherently public. For Meta we bundle a client
 * secret that's XOR-obfuscated in source to resist casual grep'ing.
 *
 * Power users can override per-provider via vault keys:
 *   TWITTER_CLIENT_ID
 *   GOOGLE_CLIENT_ID   / GOOGLE_CLIENT_SECRET
 *   META_APP_ID        / META_APP_SECRET
 *
 * When a vault key is set, it takes precedence over the bundled value.
 * When the bundled value is empty AND the vault key is unset, the
 * integration is disabled with a clear UI message.
 */

import type { ConfigManager } from "../config/ConfigManager.js";
import type { IntegrationAppKeys, IntegrationId } from "./types.js";

/**
 * Vault key that stores a JSON array of additional OAuth scopes the user
 * wants to request on top of the built-in default set for a given
 * integration. Managed by the Integrations UI credentials modal.
 */
export function extraScopesVaultKey(integration: IntegrationId): string {
  return `${integration.toUpperCase()}_EXTRA_SCOPES`;
}

/** Read (and JSON-parse) the user's extra scopes for an integration. Empty on any failure. */
export function readExtraScopes(cfg: ConfigManager, integration: IntegrationId): readonly string[] {
  if (!cfg.vault.isUnlocked()) return [];
  const raw = cfg.vault.get(extraScopesVaultKey(integration))?.reveal();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string" && s.length > 0);
  } catch {
    return [];
  }
}

/**
 * Per-integration redirect-URI override. Stored verbatim (no JSON wrap)
 * so a user can pin "https://my-tunnel.example.com/oauth/callback" and
 * daemora will use that exact string regardless of where the UI is
 * loaded — bypasses the `uiOrigin` derivation entirely. Useful for:
 *
 *   - TikTok / providers that reject http://localhost in non-sandbox
 *   - Tunnel setups where the browser's URL bar disagrees with the
 *     URL registered in the developer portal
 *   - Self-hosted users running behind a reverse proxy
 */
export function redirectUriOverrideVaultKey(integration: IntegrationId): string {
  return `${integration.toUpperCase()}_REDIRECT_URI`;
}

export function readRedirectUriOverride(cfg: ConfigManager, integration: IntegrationId): string | null {
  if (!cfg.vault.isUnlocked()) return null;
  const raw = cfg.vault.get(redirectUriOverrideVaultKey(integration))?.reveal();
  return raw && raw.length > 0 ? raw : null;
}

/**
 * Bundled Daemora app credentials. Fill these in after registering the
 * apps on each platform. Empty strings mean "not bundled" — users will
 * then need to supply their own via vault keys before the integration
 * works.
 *
 * XOR-obfuscation is applied at rest to the two values that are
 * secret-adjacent (Google secret, Meta app secret) so grep/copy-paste
 * doesn't leak them. The XOR key `XOR_KEY` is not meaningful security
 * — it's purely to keep tokens from showing up in plain-text searches.
 */
// All bundled slots intentionally empty. Users supply their own OAuth
// app credentials through the Integrations UI → credentials are persisted
// in the vault under the keys listed in `resolveIntegrationKeys` below.
// Shipping real client secrets in source would leak them to anyone
// running Daemora, and (for confidential providers) would let any
// Daemora install impersonate our OAuth app.
const BUNDLED = {
  twitter_client_id: "",
  google_client_id: "",
  google_client_secret: "",
  meta_app_id: "",
  meta_app_secret: "",
  github_client_id: "",
  github_client_secret: "",
  notion_client_id: "",
  notion_client_secret: "",
  reddit_client_id: "",
  reddit_client_secret: "",
  linkedin_client_id: "",
  linkedin_client_secret: "",
  tiktok_client_key: "",
  tiktok_client_secret: "",
} as const;

/** Not security — just keeps cleartext secrets out of casual greps. */
const XOR_KEY = "daemora-v1-obf";

/**
 * Encode a plaintext secret. No longer used at runtime — we bundle
 * plain secrets directly now — but exported in case anyone wants to
 * ship an obfuscated build artefact.
 */
export function obfuscate(plain: string): string {
  if (!plain) return "";
  const bytes = Buffer.from(plain, "utf-8");
  const out = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[i]! ^ XOR_KEY.charCodeAt(i % XOR_KEY.length);
  }
  return out.toString("base64");
}

/**
 * Resolve the OAuth app creds Daemora should use for each provider,
 * preferring user-supplied vault overrides. Called at startup AND
 * again whenever a vault change fires — don't cache the result across
 * calls for longer than the current request.
 */
export function resolveIntegrationKeys(cfg: ConfigManager): IntegrationAppKeys {
  const vault = cfg.vault;
  const readVault = (k: string): string | undefined =>
    vault.isUnlocked() ? vault.get(k)?.reveal() : undefined;

  const twitterClientId = readVault("TWITTER_CLIENT_ID") ?? BUNDLED.twitter_client_id;
  const twitterClientSecret = readVault("TWITTER_CLIENT_SECRET");
  const googleClientId = readVault("GOOGLE_CLIENT_ID") ?? BUNDLED.google_client_id;
  const googleSecret = readVault("GOOGLE_CLIENT_SECRET") ?? BUNDLED.google_client_secret;
  const metaAppId = readVault("META_APP_ID") ?? BUNDLED.meta_app_id;
  const metaSecret = readVault("META_APP_SECRET") ?? BUNDLED.meta_app_secret;
  const githubClientId = readVault("GITHUB_CLIENT_ID") ?? BUNDLED.github_client_id;
  const githubSecret = readVault("GITHUB_CLIENT_SECRET") ?? BUNDLED.github_client_secret;
  const notionClientId = readVault("NOTION_CLIENT_ID") ?? BUNDLED.notion_client_id;
  const notionSecret = readVault("NOTION_CLIENT_SECRET") ?? BUNDLED.notion_client_secret;
  const redditClientId = readVault("REDDIT_CLIENT_ID") ?? BUNDLED.reddit_client_id;
  const redditSecret = readVault("REDDIT_CLIENT_SECRET") ?? BUNDLED.reddit_client_secret;
  const linkedinClientId = readVault("LINKEDIN_CLIENT_ID") ?? BUNDLED.linkedin_client_id;
  const linkedinSecret = readVault("LINKEDIN_CLIENT_SECRET") ?? BUNDLED.linkedin_client_secret;
  const tiktokClientKey = readVault("TIKTOK_CLIENT_KEY") ?? BUNDLED.tiktok_client_key;
  const tiktokSecret = readVault("TIKTOK_CLIENT_SECRET") ?? BUNDLED.tiktok_client_secret;

  return {
    twitter: twitterClientId
      ? {
          clientId: twitterClientId,
          // Confidential client mode — only supplied when the X app type
          // is "Confidential" in the developer portal. Public clients
          // leave this undefined and skip Basic auth on token exchange.
          ...(twitterClientSecret ? { clientSecret: twitterClientSecret } : {}),
        }
      : null,
    google: googleClientId && googleSecret
      ? { clientId: googleClientId, clientSecret: googleSecret }
      : null,
    meta: metaAppId && metaSecret
      ? { appId: metaAppId, appSecret: metaSecret }
      : null,
    github: githubClientId && githubSecret
      ? { clientId: githubClientId, clientSecret: githubSecret }
      : null,
    notion: notionClientId && notionSecret
      ? { clientId: notionClientId, clientSecret: notionSecret }
      : null,
    reddit: redditClientId && redditSecret
      ? { clientId: redditClientId, clientSecret: redditSecret }
      : null,
    linkedin: linkedinClientId && linkedinSecret
      ? { clientId: linkedinClientId, clientSecret: linkedinSecret }
      : null,
    tiktok: tiktokClientKey && tiktokSecret
      ? { clientKey: tiktokClientKey, clientSecret: tiktokSecret }
      : null,
  };
}
