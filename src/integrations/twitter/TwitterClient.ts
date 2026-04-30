/**
 * TwitterClient — thin wrapper over X API v2 endpoints that Daemora
 * integration tools call. Auth is handled centrally by
 * IntegrationManager (Bearer token injected per request, auto-
 * refreshed when near expiry).
 *
 * Endpoints are taken from n8n's `Twitter/V2` node as the operation
 * map; we only expose the subset the `twitter` crew needs.
 */

import { ProviderError } from "../../util/errors.js";
import { authFetch } from "../authFetch.js";
import type { IntegrationManager } from "../IntegrationManager.js";

const API = "https://api.twitter.com/2";

export class TwitterClient {
  constructor(private readonly integrations: IntegrationManager) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const resp = await authFetch(this.integrations, "twitter", (token) =>
      fetch(`${API}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
      }),
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      if (resp.status === 401) {
        throw new ProviderError(
          `Twitter auth failed after refresh (${resp.status}). Reconnect in Settings → Integrations. ${body.slice(0, 200)}`,
          "twitter",
        );
      }
      throw new ProviderError(`Twitter ${resp.status} ${path}: ${body.slice(0, 300)}`, "twitter");
    }
    if (resp.status === 204) return {} as T;
    return (await resp.json()) as T;
  }

  /** Return the authenticated user's numeric id — cached per process. */
  async meId(): Promise<string> {
    if (this.meIdCache) return this.meIdCache;
    const body = await this.request<{ data?: { id?: string } }>("/users/me");
    const id = body.data?.id;
    if (!id) throw new ProviderError("Could not resolve Twitter user id", "twitter");
    this.meIdCache = id;
    return id;
  }
  private meIdCache?: string;
}
