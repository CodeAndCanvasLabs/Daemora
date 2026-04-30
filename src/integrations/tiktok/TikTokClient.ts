/**
 * TikTokClient — thin wrapper over TikTok for Developers Open API v2.
 *
 * Endpoints (TikTok docs — "Creator APIs"):
 *   /v2/user/info/                        profile info
 *   /v2/video/list/                       list user videos
 *   /v2/post/publish/content/init/        publish video by URL
 *   /v2/post/publish/inbox/video/init/    upload video draft-only
 *   /v2/post/publish/status/fetch/        check publish/upload status
 *
 * TikTok uses POST+JSON for everything (even reads). Pre-audit apps
 * publish as SELF_ONLY no matter what you set — callers see this in
 * the status poll response and should surface it to the user.
 */

import { ProviderError } from "../../util/errors.js";
import { authFetch } from "../authFetch.js";
import type { IntegrationManager } from "../IntegrationManager.js";

const API = "https://open.tiktokapis.com";

export class TikTokClient {
  constructor(private readonly integrations: IntegrationManager) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const resp = await authFetch(this.integrations, "tiktok", (token) =>
      fetch(`${API}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body && !init.headers ? { "Content-Type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
      }),
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      if (resp.status === 401) {
        throw new ProviderError(
          `TikTok auth failed after refresh (${resp.status}). Reconnect in Settings → Integrations. ${body.slice(0, 200)}`,
          "tiktok",
        );
      }
      throw new ProviderError(`TikTok ${resp.status} ${path}: ${body.slice(0, 300)}`, "tiktok");
    }
    if (resp.status === 204) return {} as T;
    return (await resp.json()) as T;
  }
}
