/**
 * buildWebhookUrls — compose the registration URLs for a watcher.
 *
 * Returns the three URLs a user might need to paste into a provider
 * dashboard:
 *   - `generic`  — POST target for the generic handler (bearer or HMAC)
 *   - `github`   — for repos' "Add webhook → Payload URL"
 *   - `stripe`   — for dashboard.stripe.com webhooks destination
 *
 * `publicUrl` comes from the tunnel manager / PUBLIC_URL setting. If
 * unset, falls back to `http://localhost:<port>` so the UI still shows
 * SOMETHING — just with a warning upstream.
 */

export interface WebhookUrls {
  readonly generic: string;
  readonly github: string;
  readonly stripe: string;
}

export function buildWebhookUrls(publicUrl: string, watcherId: string): WebhookUrls {
  const base = publicUrl.replace(/\/$/, "");
  return {
    generic: `${base}/hooks/watch/${encodeURIComponent(watcherId)}`,
    github: `${base}/hooks/github/${encodeURIComponent(watcherId)}`,
    stripe: `${base}/hooks/stripe/${encodeURIComponent(watcherId)}`,
  };
}
