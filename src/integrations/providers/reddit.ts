/**
 * Reddit OAuth 2.0 Provider.
 *
 * Endpoints (Reddit API docs — "OAuth2"):
 *   authorize: https://www.reddit.com/api/v1/authorize
 *   token:     https://www.reddit.com/api/v1/access_token
 *   me:        https://oauth.reddit.com/api/v1/me
 *
 * Token exchange uses HTTP Basic auth with client_id:client_secret
 * (even for installed-app flows, where the secret is empty). A
 * refresh_token is only issued when `duration=permanent` is requested.
 *
 * Reddit REQUIRES a descriptive User-Agent header on API calls or it
 * rate-limits aggressively ("changeme" / default UAs get 429'd).
 */

import { ProviderError } from "../../util/errors.js";
import type { OAuthProvider, TokenSet } from "../types.js";

const AUTHORIZE = "https://www.reddit.com/api/v1/authorize";
const TOKEN = "https://www.reddit.com/api/v1/access_token";
const ME = "https://oauth.reddit.com/api/v1/me";
const USER_AGENT = "daemora/1.0 (by /u/daemora)";

export const redditProvider: OAuthProvider = {
  id: "reddit",
  usesPKCE: false,

  authorizeUrl({ clientId, redirectUri, state, scopes }) {
    const url = new URL(AUTHORIZE);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", redirectUri);
    // permanent → refresh_token included in the token response.
    url.searchParams.set("duration", "permanent");
    url.searchParams.set("scope", scopes.join(" "));
    return url.toString();
  },

  async exchangeCode({ code, redirectUri, clientId, clientSecret }) {
    if (!clientSecret && clientSecret !== "") {
      throw new ProviderError("Reddit requires client_secret (use empty string for installed apps)", "reddit");
    }
    const json = await tokenCall({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }, clientId, clientSecret ?? "", "exchange");
    return enrichWithIdentity(json);
  },

  async refresh({ refreshToken, clientId, clientSecret }) {
    const json = await tokenCall({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }, clientId, clientSecret ?? "", "refresh");
    return enrichWithIdentity(json);
  },
};

async function tokenCall(
  params: Record<string, string>,
  clientId: string,
  clientSecret: string,
  phase: string,
): Promise<Record<string, unknown>> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const resp = await fetch(TOKEN, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new ProviderError(`Reddit token ${phase} ${resp.status}: ${body.slice(0, 300)}`, "reddit");
  }
  return (await resp.json()) as Record<string, unknown>;
}

async function enrichWithIdentity(json: Record<string, unknown>): Promise<TokenSet> {
  const accessToken = String(json["access_token"] ?? "");
  const refreshToken = typeof json["refresh_token"] === "string" ? (json["refresh_token"] as string) : undefined;
  const expiresIn = Number(json["expires_in"] ?? 0);
  const expiresAt = expiresIn > 0 ? Math.floor(Date.now() / 1000) + expiresIn : 0;
  const scope = typeof json["scope"] === "string" ? (json["scope"] as string) : "";
  const scopes = scope.split(/[\s,]+/).filter(Boolean);

  let accountId = "";
  let accountLabel = "Reddit account";
  try {
    const me = await fetch(ME, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": USER_AGENT,
      },
    });
    if (me.ok) {
      const body = (await me.json()) as { id?: string; name?: string };
      accountId = body.id ?? "";
      accountLabel = body.name ? `u/${body.name}` : accountLabel;
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
