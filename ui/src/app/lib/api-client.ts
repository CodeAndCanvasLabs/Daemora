/**
 * Typed API client — the single way the rebuilt UI talks to the backend.
 *
 * Wraps the existing `apiFetch` (which carries the loopback file-token, Tauri
 * base URL, and vault re-login), adds JSON encode/decode + typed errors, and
 * exposes resource-specific helpers. Two backends sit behind the same origin:
 *   - gateway (/api/me/*)  — central account data in Postgres (config, …)
 *   - tenant  (/api/*)     — the running agent instance (proxied by the gateway)
 */

import { apiFetch } from "../api";

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

function parse(text: string): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return text; }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await apiFetch(url, init);
  const data = parse(await res.text());
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body),
  put: <T>(url: string, body?: unknown) => request<T>("PUT", url, body),
  patch: <T>(url: string, body?: unknown) => request<T>("PATCH", url, body),
  del: <T>(url: string) => request<T>("DELETE", url),
};

// ── Central config (gateway, Postgres source of truth) ──────────────
export type ConfigMap = Record<string, unknown>;

export const configApi = {
  /** The user's saved config map (defaults are applied tenant-side for display). */
  get: () => api.get<{ config: ConfigMap }>("/api/me/config").then((r) => r.config),
  /** Partial upsert — only the keys you pass change. Returns the merged map. */
  update: (patch: ConfigMap) => api.put<{ config: ConfigMap }>("/api/me/config", patch).then((r) => r.config),
  /** Reset one key to its default (remove the override). */
  remove: (key: string) =>
    api.del<{ config: ConfigMap }>(`/api/me/config/${encodeURIComponent(key)}`).then((r) => r.config),
};

// ── Chats / sessions (tenant) — multi-chat with one ACTIVE chat ──────
export interface SessionSummary {
  id: string;
  title: string;
  updatedAt?: string;
  profileId?: string; // the agent bound to this chat
}

export const sessionsApi = {
  /** All chats, most-recently-updated first. */
  list: () => api.get<{ sessions: SessionSummary[] }>("/api/sessions").then((r) => r.sessions),
  /** Which chat is active (inbound channel messages route here). */
  getActive: () => api.get<{ sessionId: string | null; session: SessionSummary | null }>("/api/sessions/active"),
  /** Make a chat the active one (its agent + project then handle channel traffic). */
  setActive: (sessionId: string) =>
    api.put<{ sessionId: string; session: SessionSummary }>("/api/sessions/active", { sessionId }),
  /** Create a new chat. */
  create: (title?: string) =>
    api.post<{ session: SessionSummary }>("/api/sessions", title ? { title } : {}).then((r) => r.session),
  /** Delete a whole chat (cascades its messages). */
  remove: (id: string) => api.del<{ ok?: boolean }>(`/api/sessions/${encodeURIComponent(id)}`),
};
