/**
 * Notion OAuth 2.0 Provider (public integration flow).
 *
 * Endpoints (Notion docs — "Authorize users and grant access"):
 *   authorize: https://api.notion.com/v1/oauth/authorize
 *   token:     https://api.notion.com/v1/oauth/token
 *
 * Notion does NOT use scopes — at consent time the user picks which
 * pages/databases the integration can see. That selection is bound to
 * the `bot_id` returned by the token exchange.
 *
 * Notion tokens have no declared expiry and Notion does not issue
 * refresh tokens for public integrations — access is revoked only when
 * the user removes the integration from their workspace. We therefore
 * leave `expiresAt=0` and implement `refresh()` as a stub that returns
 * the existing token (Notion expects the refresh_token grant to never
 * fire; the stub keeps our refresh interface total).
 */

import { ProviderError } from "../../util/errors.js";
import type { OAuthProvider, TokenSet } from "../types.js";

const AUTHORIZE = "https://api.notion.com/v1/oauth/authorize";
const TOKEN = "https://api.notion.com/v1/oauth/token";

export const notionProvider: OAuthProvider = {
  id: "notion",
  usesPKCE: false,

  authorizeUrl({ clientId, redirectUri, state }) {
    const url = new URL(AUTHORIZE);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("owner", "user");
    url.searchParams.set("state", state);
    return url.toString();
  },

  async exchangeCode({ code, redirectUri, clientId, clientSecret }) {
    if (!clientSecret) throw new ProviderError("Notion requires client_secret for token exchange", "notion");
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const resp = await fetch(TOKEN, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new ProviderError(`Notion token exchange ${resp.status}: ${body.slice(0, 300)}`, "notion");
    }
    const json = (await resp.json()) as Record<string, unknown>;
    return shapeTokenSet(json);
  },

  async refresh({ refreshToken }) {
    // Notion public integrations don't issue refresh tokens. If we
    // ever get called, the best we can do is echo the token we were
    // handed — the caller stores it under `refreshToken` as a dual-
    // purpose long-lived access token.
    return {
      accessToken: refreshToken,
      refreshToken,
      expiresAt: 0,
      scopes: [],
      accountId: "",
      accountLabel: "Notion workspace",
    };
  },
};

function shapeTokenSet(json: Record<string, unknown>): TokenSet {
  const accessToken = String(json["access_token"] ?? "");
  const botId = String(json["bot_id"] ?? "");
  const workspaceId = String(json["workspace_id"] ?? "");
  const workspaceName = typeof json["workspace_name"] === "string"
    ? (json["workspace_name"] as string)
    : "Notion workspace";

  // Use bot_id (unique per install) as accountId; workspace_name as the
  // user-facing label.
  const accountId = botId || workspaceId || "notion";
  return {
    accessToken,
    // Notion tokens don't rotate; we stash the same string under
    // refreshToken so our refresh path (and the bridge token cache)
    // always has a value to echo back.
    refreshToken: accessToken,
    expiresAt: 0,
    scopes: [],
    accountId,
    accountLabel: workspaceName,
    raw: json,
  };
}
