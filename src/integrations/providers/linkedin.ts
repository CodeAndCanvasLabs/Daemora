/**
 * LinkedIn OAuth 2.0 Provider (Sign In with LinkedIn v2 / OpenID).
 *
 * Endpoints (LinkedIn — "Authorization Code Flow (3-legged OAuth)"):
 *   authorize: https://www.linkedin.com/oauth/v2/authorization
 *   token:     https://www.linkedin.com/oauth/v2/accessToken
 *   userinfo:  https://api.linkedin.com/v2/userinfo   (OpenID endpoint)
 *
 * Access tokens live 60 days and refresh tokens live 365 days. LinkedIn
 * only issues refresh_token for apps enrolled in the refresh-token
 * programme — if the response omits it, the integration is one-shot
 * and the user reconnects every 60 days.
 *
 * Scopes requested by default (see IntegrationManager):
 *   openid profile email w_member_social
 * w_member_social grants "post on your behalf" on the authenticated
 * user's feed. Company-page scopes (w_organization_social) need the
 * Marketing Developer Platform partnership.
 */

import { ProviderError } from "../../util/errors.js";
import type { OAuthProvider, TokenSet } from "../types.js";

const AUTHORIZE = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO = "https://api.linkedin.com/v2/userinfo";

export const linkedinProvider: OAuthProvider = {
  id: "linkedin",
  usesPKCE: false,

  authorizeUrl({ clientId, redirectUri, state, scopes }) {
    const url = new URL(AUTHORIZE);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("scope", scopes.join(" "));
    return url.toString();
  },

  async exchangeCode({ code, redirectUri, clientId, clientSecret }) {
    if (!clientSecret) throw new ProviderError("LinkedIn requires client_secret for token exchange", "linkedin");
    const json = await tokenCall({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }, "exchange");
    return enrichWithIdentity(json);
  },

  async refresh({ refreshToken, clientId, clientSecret }) {
    if (!clientSecret) throw new ProviderError("LinkedIn refresh requires client_secret", "linkedin");
    const json = await tokenCall({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
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
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new ProviderError(`LinkedIn token ${phase} ${resp.status}: ${body.slice(0, 300)}`, "linkedin");
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
  let accountLabel = "LinkedIn account";
  try {
    const me = await fetch(USERINFO, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (me.ok) {
      // OpenID userinfo response — { sub, name, email, ... }
      const body = (await me.json()) as { sub?: string; name?: string; email?: string };
      accountId = body.sub ?? "";
      accountLabel = body.name ?? body.email ?? accountLabel;
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
