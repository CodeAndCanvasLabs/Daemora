/**
 * Client-side auth helpers — vault unlock/lock only, no JWT sessions.
 *
 * Daemora has no user accounts. Same-origin API calls are authenticated
 * by the server-injected loopback file-token (handled inside
 * `apiFetch`); the only interactive credential is the vault passphrase
 * and its job is to unlock the vault, not to issue tokens.
 *
 * Shape:
 *   - `login(passphrase)` → POSTs /auth/login. On success the vault
 *     is unlocked for the life of this server process.
 *   - `lock()` → POSTs /auth/logout. Locks the vault.
 *   - `session()` → GETs /auth/session. Reports `{unlocked, exists}`.
 *
 * The passphrase is cached in `sessionStorage` so tsx-watch restarts
 * (which drop the vault key) can be transparently recovered by
 * `apiFetch`'s vault-locked retry path.
 */

function apiBase(): string {
  return (window as unknown as { __DAEMORA_API_BASE?: string }).__DAEMORA_API_BASE ?? "";
}

function fileToken(): string | null {
  const meta = document.querySelector('meta[name="api-token"]');
  return meta?.getAttribute("content") ?? null;
}

function baseHeaders(init?: RequestInit): Headers {
  const headers = new Headers(init?.headers);
  const tok = fileToken();
  if (tok && !headers.has("X-Auth-Token")) headers.set("X-Auth-Token", tok);
  if (init?.body && typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

export interface SessionInfo {
  readonly unlocked: boolean;
  readonly exists: boolean;
  readonly loopback: boolean;
}

export async function login(passphrase: string): Promise<SessionInfo> {
  const res = await fetch(`${apiBase()}/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: baseHeaders({ body: "{}" }),
    body: JSON.stringify({ passphrase }),
  });
  if (!res.ok) {
    const detail = await safeJson(res);
    throw new LoginError(detail?.code ?? "login_failed", detail?.error ?? `HTTP ${res.status}`);
  }
  // Cache the passphrase so apiFetch can silently re-unlock after a
  // dev-server restart drops the vault's in-memory key.
  try { sessionStorage.setItem("daemora_vault_pass", passphrase); } catch { /* private mode */ }
  return session();
}

export async function lock(): Promise<void> {
  try {
    await fetch(`${apiBase()}/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers: baseHeaders(),
    });
  } finally {
    try { sessionStorage.removeItem("daemora_vault_pass"); } catch { /* ignore */ }
    notifyAuthChange();
  }
}

export async function session(): Promise<SessionInfo | null> {
  const res = await fetch(`${apiBase()}/auth/session`, {
    credentials: "include",
    headers: baseHeaders(),
  });
  if (!res.ok) return null;
  return res.json();
}

// ── errors ───────────────────────────────────────────────────────────

export class LoginError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "LoginError";
  }
}

async function safeJson(res: Response): Promise<{ code?: string; error?: string } | null> {
  try { return await res.json(); } catch { return null; }
}

// ── listener utility (unchanged API) ────────────────────────────────

const listeners = new Set<() => void>();

export function onAuthChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyAuthChange(): void {
  for (const l of listeners) l();
}
