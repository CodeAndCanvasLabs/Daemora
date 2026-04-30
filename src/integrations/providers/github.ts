/**
 * GitHub OAuth 2.0 Provider.
 *
 * Endpoints (GitHub OAuth App / GitHub App user-to-server):
 *   authorize: https://github.com/login/oauth/authorize
 *   token:     https://github.com/login/oauth/access_token
 *
 * GitHub's classic OAuth Apps issue long-lived tokens with no
 * `expires_in`. GitHub Apps (recommended) issue 8-hour user tokens
 * with a refresh_token. We handle both: if the token response includes
 * `expires_in` we record the expiry; otherwise `expiresAt=0` (no
 * declared expiry) and the background refresher skips it.
 *
 * Scopes are passed as a space-separated list. For fine-grained
 * personal access (no scopes) the list is empty — we still send the
 * parameter to keep the consent screen transparent.
 */

import { ProviderError } from "../../util/errors.js";
import type { OAuthProvider, TokenSet } from "../types.js";

const AUTHORIZE = "https://github.com/login/oauth/authorize";
const TOKEN = "https://github.com/login/oauth/access_token";
const USER = "https://api.github.com/user";

export const githubProvider: OAuthProvider = {
  id: "github",
  usesPKCE: false,

  authorizeUrl({ clientId, redirectUri, state, scopes }) {
    const url = new URL(AUTHORIZE);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    if (scopes.length > 0) url.searchParams.set("scope", scopes.join(" "));
    // Forces a fresh consent screen so scope changes show up even when
    // the user has previously authorized the app.
    url.searchParams.set("allow_signup", "true");
    return url.toString();
  },

  async exchangeCode({ code, redirectUri, clientId, clientSecret }) {
    if (!clientSecret) throw new ProviderError("GitHub requires client_secret for token exchange", "github");
    const json = await tokenCall({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }, "exchange");
    return enrichWithIdentity(json);
  },

  async refresh({ refreshToken, clientId, clientSecret }) {
    if (!clientSecret) throw new ProviderError("GitHub refresh requires client_secret", "github");
    const json = await tokenCall({
      client_id: clientId,
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
      Accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new ProviderError(`GitHub token ${phase} ${resp.status}: ${body.slice(0, 300)}`, "github");
  }
  const json = (await resp.json()) as Record<string, unknown>;
  if (json["error"]) {
    throw new ProviderError(
      `GitHub token ${phase}: ${String(json["error_description"] ?? json["error"])}`,
      "github",
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

  let accountId = "";
  let accountLabel = "GitHub account";
  try {
    const me = await fetch(USER, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "daemora",
      },
    });
    if (me.ok) {
      const body = (await me.json()) as { id?: number; login?: string; name?: string };
      accountId = String(body.id ?? "");
      accountLabel = body.login ? `@${body.login}` : body.name ?? accountLabel;
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
