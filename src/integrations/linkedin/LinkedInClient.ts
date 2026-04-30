/**
 * LinkedInClient — thin wrapper over LinkedIn's REST API v2.
 *
 * Scopes we request by default only unlock member-level endpoints:
 *   /v2/userinfo            identity
 *   /v2/ugcPosts            post to own feed (w_member_social)
 *   /v2/socialActions/...   comment & like on your own posts
 *
 * Org / company-page endpoints need Marketing Developer Platform
 * partnership — we don't expose those tools here.
 *
 * LinkedIn requires `X-Restli-Protocol-Version: 2.0.0` on most write
 * endpoints; we send it on every request to keep the surface uniform.
 */

import { ProviderError } from "../../util/errors.js";
import { authFetch } from "../authFetch.js";
import type { IntegrationManager } from "../IntegrationManager.js";

const API = "https://api.linkedin.com";

export class LinkedInClient {
  constructor(private readonly integrations: IntegrationManager) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const resp = await authFetch(this.integrations, "linkedin", (token) =>
      fetch(`${API}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Restli-Protocol-Version": "2.0.0",
          ...(init.body && !init.headers ? { "Content-Type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
      }),
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      if (resp.status === 401) {
        throw new ProviderError(
          `LinkedIn auth failed after refresh (${resp.status}). Reconnect in Settings → Integrations. ${body.slice(0, 200)}`,
          "linkedin",
        );
      }
      throw new ProviderError(`LinkedIn ${resp.status} ${path}: ${body.slice(0, 300)}`, "linkedin");
    }
    if (resp.status === 204) return {} as T;
    return (await resp.json()) as T;
  }

  /** Resolve the authenticated user's `urn:li:person:<sub>` URN. Cached per process. */
  async personUrn(): Promise<string> {
    if (this.urnCache) return this.urnCache;
    const info = await this.request<{ sub?: string }>("/v2/userinfo");
    if (!info.sub) throw new ProviderError("Could not resolve LinkedIn person URN", "linkedin");
    this.urnCache = `urn:li:person:${info.sub}`;
    return this.urnCache;
  }
  private urnCache?: string;
}
