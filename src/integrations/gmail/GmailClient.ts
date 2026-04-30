/**
 * GmailClient — thin wrapper over Gmail API v1 endpoints.
 *
 * Auth lives in IntegrationManager; the Bearer is injected per request
 * via `authFetch`, which also retries once on 401 against a force-
 * refresh. All responses are JSON; Gmail's "raw" payload is base64url-
 * encoded RFC 5322 — we provide a small helper for building those.
 *
 * n8n's GmailV2 node is the reference surface: send/reply/draft, list,
 * get, search, trash/untrash, delete, label CRUD, labels apply/remove,
 * thread get / modify, markAsRead / markAsUnread.
 */

import { ProviderError } from "../../util/errors.js";
import { authFetch } from "../authFetch.js";
import type { IntegrationManager } from "../IntegrationManager.js";

const API = "https://gmail.googleapis.com/gmail/v1";

export class GmailClient {
  constructor(private readonly integrations: IntegrationManager) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const resp = await authFetch(this.integrations, "gmail", (token) =>
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
          `Gmail auth failed after refresh (${resp.status}). Reconnect in Settings → Integrations. ${body.slice(0, 200)}`,
          "google",
        );
      }
      throw new ProviderError(`Gmail ${resp.status} ${path}: ${body.slice(0, 300)}`, "google");
    }
    if (resp.status === 204) return {} as T;
    return (await resp.json()) as T;
  }
}

/**
 * Build a base64url-encoded RFC 5322 message Gmail can send as `raw`.
 * Handles plain bodies; for HTML set `html=true`. Attachments aren't
 * supported here — we keep them out of the default tool surface to
 * avoid a multipart-encoder dependency.
 */
export function buildRawMessage(args: {
  to: string;
  subject: string;
  body: string;
  cc?: string | undefined;
  bcc?: string | undefined;
  replyToMessageId?: string | undefined;
  html?: boolean | undefined;
}): string {
  const lines: string[] = [];
  lines.push(`To: ${args.to}`);
  if (args.cc) lines.push(`Cc: ${args.cc}`);
  if (args.bcc) lines.push(`Bcc: ${args.bcc}`);
  lines.push(`Subject: ${args.subject}`);
  lines.push("MIME-Version: 1.0");
  lines.push(`Content-Type: ${args.html ? "text/html" : "text/plain"}; charset=utf-8`);
  if (args.replyToMessageId) lines.push(`In-Reply-To: ${args.replyToMessageId}`);
  lines.push("");
  lines.push(args.body);

  const raw = lines.join("\r\n");
  return Buffer.from(raw, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
