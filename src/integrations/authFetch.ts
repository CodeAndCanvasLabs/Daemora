/**
 * authFetch — shared helper that wraps a provider API call with
 * transparent token refresh on 401. Integration clients call this
 * instead of fetch() directly so a revoked/rotated access token
 * auto-recovers without bubbling a confusing 401 up to the agent.
 *
 * Flow:
 *   1. Pull current access token from IntegrationManager.
 *   2. Call the builder with that token.
 *   3. If the response status is 401, force-refresh and retry once.
 *   4. On the retry still-401, bubble the failure up.
 *
 * The `builder` callback receives the live token string and returns
 * the Response — it controls headers / method / body. We stay out of
 * that so callers can handle multipart, form-urlencoded, raw fetch
 * against non-default hosts, etc.
 */

import type { IntegrationManager } from "./IntegrationManager.js";
import type { IntegrationId } from "./types.js";

export async function authFetch(
  integrations: IntegrationManager,
  integration: IntegrationId,
  builder: (token: string) => Promise<Response>,
): Promise<Response> {
  let token = await integrations.getAccessToken(integration);
  if (!token) throw new Error(`${integration} not connected`);
  let resp = await builder(token);
  if (resp.status !== 401) return resp;

  // Token is formally valid (or we haven't tried refreshing) but the
  // provider rejected it — force-refresh and retry once. Don't retry
  // again: the second 401 is either a genuine revocation or a
  // scope issue the user has to fix by reconnecting.
  const fresh = await integrations.forceRefresh(integration);
  if (!fresh || fresh === token) return resp;
  token = fresh;
  resp = await builder(token);
  return resp;
}
