/**
 * Twitter / X OAuth 2.0 Provider with PKCE.
 *
 * Endpoints (per https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token):
 *   authorize: https://x.com/i/oauth2/authorize
 *   token:     https://api.x.com/2/oauth2/token
 *
 * PKCE is always required. `client_secret` is OPTIONAL and depends on
 * the app type registered in the X developer portal:
 *
 *   - Public client    → no secret. Token exchange sends `client_id` in
 *                        the form body; PKCE alone authenticates.
 *   - Confidential cli → secret is required. Token exchange MUST send
 *                        `Authorization: Basic base64(client_id:secret)`
 *                        per the X docs.
 *
 * We support both: when `clientSecret` is provided we attach the Basic
 * header; otherwise we fall through to public-client behaviour.
 *
 * Default scopes we request: tweet.read, tweet.write, users.read,
 * follows.read, follows.write, like.read, like.write, offline.access.
 * `offline.access` is what grants a refresh_token.
 */

import { createHash } from "node:crypto";

import { ProviderError } from "../../util/errors.js";
import type { OAuthProvider, TokenSet } from "../types.js";

const AUTHORIZE = "https://x.com/i/oauth2/authorize";
const TOKEN = "https://api.x.com/2/oauth2/token";
const ME = "https://api.x.com/2/users/me";

export const twitterProvider: OAuthProvider = {
  id: "twitter",
  usesPKCE: true,

  authorizeUrl({ clientId, redirectUri, state, pkceVerifier, scopes }) {
    if (!pkceVerifier) throw new ProviderError("Twitter requires PKCE; verifier missing", "twitter");
    // Recompute the challenge so callers only need to remember the verifier.
    const challenge = sha256B64url(pkceVerifier);
    const url = new URL(AUTHORIZE);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  },

  async exchangeCode({ code, redirectUri, pkceVerifier, clientId, clientSecret }) {
    if (!pkceVerifier) throw new ProviderError("Twitter requires PKCE verifier for exchange", "twitter");
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      // Public clients identify themselves via client_id in the body.
      // Confidential clients also use Basic auth, but X tolerates having
      // client_id in both places, so we always include it.
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: pkceVerifier,
    });
    const resp = await fetch(TOKEN, {
      method: "POST",
      headers: tokenAuthHeaders(clientId, clientSecret),
      body: form.toString(),
    });
    const json = await readTokenResponse(resp, "exchange");
    const tokenSet = await enrichWithIdentity(json);
    return tokenSet;
  },

  async refresh({ refreshToken, clientId, clientSecret }) {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });
    const resp = await fetch(TOKEN, {
      method: "POST",
      headers: tokenAuthHeaders(clientId, clientSecret),
      body: form.toString(),
    });
    const json = await readTokenResponse(resp, "refresh");
    return enrichWithIdentity(json);
  },
};

/**
 * Build the headers for a token-endpoint request. Confidential clients
 * (clientSecret present) get an HTTP Basic auth header; public clients
 * just send the form-encoded body.
 */
function tokenAuthHeaders(clientId: string, clientSecret: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (clientSecret) {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    headers["Authorization"] = `Basic ${basic}`;
  }
  return headers;
}

async function readTokenResponse(resp: Response, phase: string): Promise<Record<string, unknown>> {
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new ProviderError(`Twitter token ${phase} ${resp.status}: ${body.slice(0, 300)}`, "twitter");
  }
  return (await resp.json()) as Record<string, unknown>;
}

async function enrichWithIdentity(json: Record<string, unknown>): Promise<TokenSet> {
  const accessToken = String(json["access_token"] ?? "");
  const refreshToken = typeof json["refresh_token"] === "string" ? (json["refresh_token"] as string) : undefined;
  const expiresIn = Number(json["expires_in"] ?? 0);
  const expiresAt = expiresIn > 0 ? Math.floor(Date.now() / 1000) + expiresIn : 0;
  const scopes = typeof json["scope"] === "string"
    ? (json["scope"] as string).split(" ").filter(Boolean)
    : [];

  // Fetch the authenticated user so we can label the connection.
  let accountId = "";
  let accountLabel = "Twitter account";
  try {
    const me = await fetch(ME, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (me.ok) {
      const body = (await me.json()) as { data?: { id?: string; username?: string; name?: string } };
      const d = body.data ?? {};
      accountId = String(d.id ?? "");
      accountLabel = d.username ? `@${d.username}` : d.name ?? accountLabel;
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

function sha256B64url(input: string): string {
  return createHash("sha256").update(input).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
