/**
 * TikTok for Developers OAuth 2.0 Provider (Login Kit v2).
 *
 * Endpoints (TikTok docs — "Login Kit for Web"):
 *   authorize: https://www.tiktok.com/v2/auth/authorize/
 *   token:     https://open.tiktokapis.com/v2/oauth/token/
 *   userinfo:  https://open.tiktokapis.com/v2/user/info/
 *
 * TikTok uses `client_key` (not client_id) at the authorize endpoint
 * but `client_id` is also accepted on some endpoints — we send both
 * where the docs permit to keep the behaviour stable.
 *
 * PKCE is REQUIRED for /v2/auth/authorize/ — without `code_challenge`
 * + `code_challenge_method=S256` TikTok rejects the request with
 * `errCode=10007 error_type=code_challenge`. We compute the challenge
 * here from the verifier the IntegrationManager generates.
 *
 * Access tokens live 24 hours; refresh tokens live 365 days and rotate
 * on every refresh — we always forward the newly returned
 * refresh_token instead of reusing the old one.
 *
 * IMPORTANT: until your TikTok app passes audit, `video.publish` tokens
 * still authenticate but uploaded videos are forced to SELF_ONLY
 * visibility. Treat "pre-audit" as a read/test mode.
 */

import { createHash } from "node:crypto";

import { ProviderError } from "../../util/errors.js";
import type { OAuthProvider, TokenSet } from "../types.js";

const AUTHORIZE = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN = "https://open.tiktokapis.com/v2/oauth/token/";
const USERINFO = "https://open.tiktokapis.com/v2/user/info/";

export const tiktokProvider: OAuthProvider = {
  id: "tiktok",
  usesPKCE: true,

  authorizeUrl({ clientId, redirectUri, state, scopes, pkceVerifier }) {
    if (!pkceVerifier) throw new ProviderError("TikTok requires PKCE; verifier missing", "tiktok");
    const challenge = sha256B64url(pkceVerifier);
    const url = new URL(AUTHORIZE);
    url.searchParams.set("client_key", clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scopes.join(","));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  },

  async exchangeCode({ code, redirectUri, clientId, clientSecret, pkceVerifier }) {
    if (!clientSecret) throw new ProviderError("TikTok requires client_secret for token exchange", "tiktok");
    if (!pkceVerifier) throw new ProviderError("TikTok requires PKCE verifier for token exchange", "tiktok");
    const json = await tokenCall({
      client_key: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code_verifier: pkceVerifier,
    }, "exchange");
    return enrichWithIdentity(json);
  },

  async refresh({ refreshToken, clientId, clientSecret }) {
    if (!clientSecret) throw new ProviderError("TikTok refresh requires client_secret", "tiktok");
    const json = await tokenCall({
      client_key: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }, "refresh");
    return enrichWithIdentity(json);
  },
};

async function tokenCall(
  params: Record<string, string>,
  phase: string,
): Promise<Record<string, unknown>> {
  const resp = await fetch(TOKEN, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new ProviderError(`TikTok token ${phase} ${resp.status}: ${body.slice(0, 300)}`, "tiktok");
  }
  const json = (await resp.json()) as Record<string, unknown>;
  if (json["error"] && json["error"] !== "ok") {
    throw new ProviderError(
      `TikTok token ${phase}: ${String(json["error_description"] ?? json["error"])}`,
      "tiktok",
    );
  }
  return json;
}

async function enrichWithIdentity(json: Record<string, unknown>): Promise<TokenSet> {
  const accessToken = String(json["access_token"] ?? "");
  const refreshToken = typeof json["refresh_token"] === "string" ? (json["refresh_token"] as string) : undefined;
  const expiresIn = Number(json["expires_in"] ?? 0);
  const expiresAt = expiresIn > 0 ? Math.floor(Date.now() / 1000) + expiresIn : 0;
  const scope = typeof json["scope"] === "string" ? (json["scope"] as string) : "";
  const scopes = scope.split(/[\s,]+/).filter(Boolean);
  const openId = typeof json["open_id"] === "string" ? (json["open_id"] as string) : "";

  let accountId = openId;
  let accountLabel = "TikTok account";
  try {
    const url = new URL(USERINFO);
    url.searchParams.set("fields", "open_id,union_id,avatar_url,display_name,username");
    const me = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (me.ok) {
      const body = (await me.json()) as { data?: { user?: { open_id?: string; display_name?: string; username?: string } } };
      const user = body.data?.user;
      if (user?.open_id) accountId = user.open_id;
      accountLabel = user?.username ? `@${user.username}` : user?.display_name ?? accountLabel;
    }
  } catch { /* non-fatal */ }

  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt,
    scopes,
    accountId,
    accountLabel,
    raw: json,
  };
}

/**
 * SHA-256 of the PKCE verifier, base64url-encoded without padding —
 * exactly what TikTok (and the OAuth 2.0 PKCE spec, RFC 7636) expects
 * as the `code_challenge` when `code_challenge_method=S256`.
 */
function sha256B64url(input: string): string {
  return createHash("sha256").update(input).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
