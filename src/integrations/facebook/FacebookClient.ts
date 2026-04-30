/**
 * FacebookClient — thin wrapper over the Meta Graph API v19, scoped to
 * Facebook Pages operations (list, post, comment, insights). Auth goes
 * through IntegrationManager; Meta doesn't issue refresh_tokens in the
 * classic sense — we exchange the stored long-lived token when it
 * approaches expiry (handled in IntegrationManager.refresh).
 *
 * Page tokens vs user tokens: Graph API requires a Page Access Token
 * (not the user token) for posting/reading Page insights. We fetch
 * pages via /me/accounts and cache their page_access_token per Page.
 */

import { ProviderError } from "../../util/errors.js";
import type { IntegrationManager } from "../IntegrationManager.js";

const GRAPH = "https://graph.facebook.com/v19.0";

export class FacebookClient {
  private readonly pageTokenCache = new Map<string, string>();

  constructor(private readonly integrations: IntegrationManager) {}

  async userToken(): Promise<string> {
    const token = await this.integrations.getAccessToken("facebook");
    if (!token) throw new ProviderError("Facebook is not connected. Connect it in Settings → Integrations.", "meta");
    return token;
  }

  /** Force a user-token refresh (used by the 401-retry path). Page
   *  tokens don't expire the same way, so we only cycle the user
   *  token and re-fetch page tokens on the next listPages() call. */
  private async refreshUserToken(): Promise<string | null> {
    this.pageTokenCache.clear();
    return this.integrations.forceRefresh("facebook");
  }

  /** Fetch the user's managed Pages + their page tokens. */
  async listPages(): Promise<ReadonlyArray<{ id: string; name: string; access_token: string; category?: string }>> {
    const token = await this.userToken();
    const data = await this.request<{ data?: Array<{ id: string; name: string; access_token: string; category?: string }> }>(
      `/me/accounts?fields=id,name,access_token,category`,
      {},
      token,
    );
    const pages = data.data ?? [];
    for (const p of pages) this.pageTokenCache.set(p.id, p.access_token);
    return pages;
  }

  /** Look up (or fetch) a page's access token, given a Page id. */
  async pageToken(pageId: string): Promise<string> {
    const cached = this.pageTokenCache.get(pageId);
    if (cached) return cached;
    await this.listPages(); // primes the cache
    const fresh = this.pageTokenCache.get(pageId);
    if (!fresh) throw new ProviderError(`Facebook Page ${pageId} not found on this account.`, "meta");
    return fresh;
  }

  async request<T>(path: string, init: RequestInit = {}, bearer?: string): Promise<T> {
    let token = bearer ?? (await this.userToken());
    let resp = await fbFetch(GRAPH, path, token, init);
    // On 401: if we were using the user token (not a page token),
    // refresh once and retry. Page tokens don't come back from a
    // refresh — the user must re-connect to fix Page-level 401s.
    if (resp.status === 401 && !bearer) {
      const fresh = await this.refreshUserToken();
      if (fresh && fresh !== token) {
        token = fresh;
        resp = await fbFetch(GRAPH, path, token, init);
      }
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      if (resp.status === 401) {
        throw new ProviderError(
          `Facebook auth failed after refresh (${resp.status}). Reconnect in Settings → Integrations. ${body.slice(0, 200)}`,
          "meta",
        );
      }
      throw new ProviderError(`Facebook ${resp.status} ${path}: ${body.slice(0, 300)}`, "meta");
    }
    if (resp.status === 204) return {} as T;
    return (await resp.json()) as T;
  }
}

async function fbFetch(
  base: string,
  path: string,
  token: string,
  init: RequestInit,
): Promise<Response> {
  const url = `${base}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
  return fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}
