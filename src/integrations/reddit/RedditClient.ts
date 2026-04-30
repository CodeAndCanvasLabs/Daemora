/**
 * RedditClient — thin wrapper over Reddit's oauth.reddit.com surface.
 *
 * Reddit strongly requires a descriptive User-Agent; without one
 * requests get rate-limited hard. We set `daemora/1.0` on every call.
 *
 * Submit / comment / vote / save endpoints all take form-urlencoded
 * bodies, not JSON — the helper methods below handle that.
 */

import { ProviderError } from "../../util/errors.js";
import { authFetch } from "../authFetch.js";
import type { IntegrationManager } from "../IntegrationManager.js";

const API = "https://oauth.reddit.com";
const USER_AGENT = "daemora/1.0 (by /u/daemora)";

export class RedditClient {
  constructor(private readonly integrations: IntegrationManager) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const resp = await authFetch(this.integrations, "reddit", (token) =>
      fetch(`${API}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": USER_AGENT,
          ...(init.headers ?? {}),
        },
      }),
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      if (resp.status === 401) {
        throw new ProviderError(
          `Reddit auth failed after refresh (${resp.status}). Reconnect in Settings → Integrations. ${body.slice(0, 200)}`,
          "reddit",
        );
      }
      if (resp.status === 429) {
        throw new ProviderError(`Reddit rate-limited (429). Retry-After: ${resp.headers.get("retry-after") ?? "unknown"}`, "reddit");
      }
      throw new ProviderError(`Reddit ${resp.status} ${path}: ${body.slice(0, 300)}`, "reddit");
    }
    if (resp.status === 204) return {} as T;
    return (await resp.json()) as T;
  }

  /** POST a form-urlencoded body — Reddit's write endpoints expect this, not JSON. */
  async form<T>(path: string, params: Record<string, string | number | boolean>): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) body.set(k, String(v));
    return this.request<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  }
}
