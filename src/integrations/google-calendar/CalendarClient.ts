/**
 * CalendarClient — thin wrapper over Google Calendar API v3 endpoints.
 *
 * Same auth model as GmailClient: IntegrationManager injects the
 * Bearer, `authFetch` retries once on 401 with a forced refresh.
 *
 * Integration id is `google_calendar` (underscore — kept consistent
 * with our snake-case convention for multi-word integrations).
 */

import { ProviderError } from "../../util/errors.js";
import { authFetch } from "../authFetch.js";
import type { IntegrationManager } from "../IntegrationManager.js";

const API = "https://www.googleapis.com/calendar/v3";

export class CalendarClient {
  constructor(private readonly integrations: IntegrationManager) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const resp = await authFetch(this.integrations, "google_calendar", (token) =>
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
          `Google Calendar auth failed after refresh (${resp.status}). Reconnect in Settings → Integrations. ${body.slice(0, 200)}`,
          "google",
        );
      }
      throw new ProviderError(`Calendar ${resp.status} ${path}: ${body.slice(0, 300)}`, "google");
    }
    if (resp.status === 204) return {} as T;
    return (await resp.json()) as T;
  }
}
