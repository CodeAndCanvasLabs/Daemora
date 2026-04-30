/**
 * Google OAuth 2.0 Provider — used for YouTube Data API.
 *
 * Endpoints:
 *   authorize: https://accounts.google.com/o/oauth2/v2/auth
 *   token:     https://oauth2.googleapis.com/token
 *
 * Google supports PKCE for confidential clients too, and we use it —
 * keeps the flow uniform with Twitter and protects the code grant.
 *
 * `access_type=offline` + `prompt=consent` is what ensures a
 * refresh_token is returned on first consent (Google omits it on
 * subsequent consents if you don't force prompt=consent).
 */

import { createHash } from "node:crypto";

import { ProviderError } from "../../util/errors.js";
import type { OAuthProvider, TokenSet } from "../types.js";

const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const USERINFO = "https://www.googleapis.com/oauth2/v2/userinfo";

export const googleProvider: OAuthProvider = {
  id: "google",
  usesPKCE: true,

  authorizeUrl({ clientId, redirectUri, state, pkceVerifier, scopes }) {
    if (!pkceVerifier) throw new ProviderError("Google PKCE verifier missing", "google");
    const challenge = sha256B64url(pkceVerifier);
    const url = new URL(AUTHORIZE);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    return url.toString();
  },

  async exchangeCode({ code, redirectUri, pkceVerifier, clientId, clientSecret }) {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      ...(pkceVerifier ? { code_verifier: pkceVerifier } : {}),
    });
    const resp = await fetch(TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const json = await readTokenResponse(resp, "exchange");
    return enrichWithIdentity(json);
  },

  async refresh({ refreshToken, clientId, clientSecret }) {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    });
    const resp = await fetch(TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const json = await readTokenResponse(resp, "refresh");
    // Google often omits refresh_token on refresh responses — carry
    // the old one forward by letting the caller merge. Here we just
    // return what was given so `expiresAt` / `accessToken` get updated.
    return enrichWithIdentity(json);
  },
};

async function readTokenResponse(resp: Response, phase: string): Promise<Record<string, unknown>> {
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new ProviderError(`Google token ${phase} ${resp.status}: ${body.slice(0, 300)}`, "google");
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
  let accountLabel = "Google account";
  try {
    const me = await fetch(USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (me.ok) {
      const body = (await me.json()) as { id?: string; email?: string; name?: string };
      accountId = body.id ?? "";
      accountLabel = body.email ?? body.name ?? accountLabel;
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
