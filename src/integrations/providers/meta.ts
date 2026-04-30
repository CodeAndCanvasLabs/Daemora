/**
 * Meta (Facebook + Instagram) OAuth 2.0 Provider.
 *
 * Endpoints (Facebook Login for Business / Graph API v19):
 *   authorize: https://www.facebook.com/v19.0/dialog/oauth
 *   token:     https://graph.facebook.com/v19.0/oauth/access_token
 *
 * Meta does NOT use PKCE — it uses the classic confidential-client
 * flow with a bundled `client_secret`. Refresh is implicit: short-lived
 * user tokens can be exchanged for a long-lived (~60 day) token via
 * `fb_exchange_token`. There is no refresh_token grant.
 *
 * For Instagram: the same OAuth flow is used with IG scopes; the IG
 * integration picks the right Business account off the user's Pages
 * after connect.
 */

import { ProviderError } from "../../util/errors.js";
import type { OAuthProvider, TokenSet } from "../types.js";

const GRAPH_VERSION = "v19.0";
const AUTHORIZE = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
const TOKEN = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`;
const ME = `https://graph.facebook.com/${GRAPH_VERSION}/me`;

export const metaProvider: OAuthProvider = {
  id: "meta",
  usesPKCE: false,

  authorizeUrl({ clientId, redirectUri, state, scopes }) {
    const url = new URL(AUTHORIZE);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", scopes.join(","));
    url.searchParams.set("state", state);
    return url.toString();
  },

  async exchangeCode({ code, redirectUri, clientId, clientSecret }) {
    if (!clientSecret) throw new ProviderError("Meta requires client_secret for token exchange", "meta");
    // Step 1: exchange code for a short-lived user token.
    const short = await metaTokenCall({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    }, "exchange");

    // Step 2: exchange for a long-lived token (best-effort; falls back
    // to the short-lived token if the long-lived exchange errors out).
    let finalToken = String(short["access_token"] ?? "");
    let expiresIn = Number(short["expires_in"] ?? 0);
    try {
      const longLived = await metaTokenCall({
        grant_type: "fb_exchange_token",
        client_id: clientId,
        client_secret: clientSecret,
        fb_exchange_token: finalToken,
      }, "long-lived exchange");
      finalToken = String(longLived["access_token"] ?? finalToken);
      expiresIn = Number(longLived["expires_in"] ?? expiresIn);
    } catch {
      // Short-lived token still works — log upstream.
    }

    return enrichWithIdentity(finalToken, expiresIn, short);
  },

  async refresh({ refreshToken, clientId, clientSecret }) {
    // Meta doesn't issue refresh_tokens — instead we treat the stored
    // long-lived user token as both access and refresh, and use
    // `fb_exchange_token` to extend it when it's close to expiry.
    if (!clientSecret) throw new ProviderError("Meta refresh requires client_secret", "meta");
    const json = await metaTokenCall({
      grant_type: "fb_exchange_token",
      client_id: clientId,
      client_secret: clientSecret,
      fb_exchange_token: refreshToken,
    }, "refresh");
    const token = String(json["access_token"] ?? "");
    const expiresIn = Number(json["expires_in"] ?? 0);
    return enrichWithIdentity(token, expiresIn, json);
  },
};

async function metaTokenCall(
  params: Record<string, string>,
  phase: string,
): Promise<Record<string, unknown>> {
  const url = `${TOKEN}?${new URLSearchParams(params).toString()}`;
  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new ProviderError(`Meta token ${phase} ${resp.status}: ${body.slice(0, 300)}`, "meta");
  }
  return (await resp.json()) as Record<string, unknown>;
}

async function enrichWithIdentity(
  accessToken: string,
  expiresIn: number,
  raw: Record<string, unknown>,
): Promise<TokenSet> {
  const expiresAt = expiresIn > 0 ? Math.floor(Date.now() / 1000) + expiresIn : 0;

  let accountId = "";
  let accountLabel = "Meta account";
  try {
    const meResp = await fetch(`${ME}?fields=id,name,email`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (meResp.ok) {
      const me = (await meResp.json()) as { id?: string; name?: string; email?: string };
      accountId = me.id ?? "";
      accountLabel = me.name ?? me.email ?? accountLabel;
    }
  } catch { /* non-fatal */ }

  return {
    accessToken,
    // Meta's long-lived user token doubles as the refresh credential.
    refreshToken: accessToken,
    expiresAt,
    scopes: [],
    accountId,
    accountLabel,
    raw,
  };
}
