/**
 * Authenticated API fetch helper.
 * Reads the auth token from the server-injected <meta name="api-token"> tag
 * and attaches it to all API requests automatically.
 *
 * In Tauri desktop mode, window.__DAEMORA_API_BASE is injected by the Rust
 * supervisor after Daemora starts. All relative /api/* calls get prefixed
 * with the dynamic localhost URL.
 */

declare global {
  interface Window {
    __DAEMORA_API_BASE?: string;
    __TAURI__?: boolean;
  }
}

// Tauri desktop mode detection
const _tauriConfig = (() => {
  if ((window as any).__TAURI_INTERNALS__) {
    window.__TAURI__ = true;
  }
  return window.__TAURI__ ? {} : null;
})();

function getApiBase(): string {
  return window.__DAEMORA_API_BASE || "";
}

function resolveUrl(url: string): string {
  const base = getApiBase();
  if (!base || url.startsWith("http://") || url.startsWith("https://")) return url;
  return `${base}${url}`;
}

function getApiToken(): string {
  const meta = document.querySelector('meta[name="api-token"]');
  return meta?.getAttribute("content") || "";
}

/**
 * Fetch wrapper that auto-attaches the API auth token.
 * Drop-in replacement for window.fetch for /api/* calls.
 */
export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = getApiToken();
  const headers = new Headers(init?.headers);

  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  if (init?.body && typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(resolveUrl(url), { ...init, headers });
}

/**
 * Convenience: GET JSON from an API endpoint.
 */
export async function apiGet<T = unknown>(url: string): Promise<T> {
  const res = await apiFetch(url);
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Convenience: POST/PUT/PATCH/DELETE JSON to an API endpoint.
 */
export async function apiJson<T = unknown>(
  url: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown
): Promise<T> {
  const res = await apiFetch(url, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Build an EventSource URL with the auth token as a query param
 * (EventSource can't set custom headers).
 */
export function apiStreamUrl(url: string): string {
  const resolved = resolveUrl(url);
  const token = getApiToken();
  const sep = resolved.includes("?") ? "&" : "?";
  return token ? `${resolved}${sep}token=${token}` : resolved;
}
