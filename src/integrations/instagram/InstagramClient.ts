/**
 * InstagramClient — wraps the Instagram Graph API (v19) for the
 * `instagram` crew. IG Business accounts hang off Facebook Pages, so
 * the auth flow is the Meta OAuth flow with IG scopes; we then derive
 * the IG Business Account id from the user's connected Pages.
 *
 * Publishing is a 2-step container → publish flow — put the image URL
 * into a container via POST /{ig-user-id}/media, then publish with
 * POST /{ig-user-id}/media_publish.
 */

import { ProviderError } from "../../util/errors.js";
import type { IntegrationManager } from "../IntegrationManager.js";

const GRAPH = "https://graph.facebook.com/v19.0";

export class InstagramClient {
  /** Cached IG Business Account id → page_access_token. */
  private readonly igCache = new Map<string, { pageId: string; pageToken: string }>();

  constructor(private readonly integrations: IntegrationManager) {}

  async userToken(): Promise<string> {
    const token = await this.integrations.getAccessToken("instagram");
    if (!token) throw new ProviderError("Instagram is not connected. Connect it in Settings → Integrations.", "meta");
    return token;
  }

  /**
   * List all IG Business accounts the connected user can publish to.
   * Each entry also carries the backing Page's access_token — that's
   * the token you use for all IG API calls against that account.
   */
  async listAccounts(): Promise<ReadonlyArray<{ igUserId: string; username: string; pageId: string; pageName: string }>> {
    const token = await this.userToken();
    const resp = await this.raw<{
      data?: Array<{
        id: string;
        name: string;
        access_token: string;
        instagram_business_account?: { id: string };
      }>;
    }>(
      `/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}`,
      {},
      token,
    );
    const out: Array<{ igUserId: string; username: string; pageId: string; pageName: string }> = [];
    for (const p of resp.data ?? []) {
      if (!p.instagram_business_account?.id) continue;
      const ig = p.instagram_business_account as unknown as { id: string; username?: string };
      this.igCache.set(ig.id, { pageId: p.id, pageToken: p.access_token });
      out.push({
        igUserId: ig.id,
        username: ig.username ?? "",
        pageId: p.id,
        pageName: p.name,
      });
    }
    return out;
  }

  async tokenForIgUser(igUserId: string): Promise<string> {
    const cached = this.igCache.get(igUserId);
    if (cached) return cached.pageToken;
    await this.listAccounts();
    const fresh = this.igCache.get(igUserId);
    if (!fresh) throw new ProviderError(`IG Business Account ${igUserId} not accessible with the current token.`, "meta");
    return fresh.pageToken;
  }

  /** Authenticated Graph API request. Adds access_token as a query param. */
  async raw<T>(path: string, init: RequestInit = {}, bearer?: string): Promise<T> {
    let token = bearer ?? (await this.userToken());
    let resp = await igFetch(GRAPH, path, token, init);
    // Retry once on 401 with a fresh user token. Page/IG tokens that
    // come from bearer= aren't cycled here — the caller's cache
    // (igCache) is cleared on force-refresh via listAccounts.
    if (resp.status === 401 && !bearer) {
      this.igCache.clear();
      const fresh = await this.integrations.forceRefresh("instagram");
      if (fresh && fresh !== token) {
        token = fresh;
        resp = await igFetch(GRAPH, path, token, init);
      }
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      if (resp.status === 401) {
        throw new ProviderError(
          `Instagram auth failed after refresh (${resp.status}). Reconnect in Settings → Integrations. ${body.slice(0, 200)}`,
          "meta",
        );
      }
      throw new ProviderError(`Instagram ${resp.status} ${path}: ${body.slice(0, 300)}`, "meta");
    }
    if (resp.status === 204) return {} as T;
    return (await resp.json()) as T;
  }
}

async function igFetch(
  base: string,
  path: string,
  token: string,
  init: RequestInit,
): Promise<Response> {
  const url = `${base}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
  return fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}
