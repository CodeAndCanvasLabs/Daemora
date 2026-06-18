/**
 * Tenant-side secret boot client.
 *
 * At boot, a gateway-fronted tenant calls the gateway's /internal/secrets with
 * its signed identity token and holds the result IN-MEMORY — so BYOK secrets
 * never live on the tenant machine's disk or env (threat T6).
 *
 * Fails soft: any error → {} (the caller decides whether to fall back to env).
 */

import { createLogger } from "../util/logger.js";

const log = createLogger("multitenant.secretBoot");

export async function fetchTenantSecrets(
  gatewayUrl: string,
  identityToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, string>> {
  try {
    const url = `${gatewayUrl.replace(/\/+$/, "")}/internal/secrets`;
    const res = await fetchImpl(url, { headers: { "x-daemora-user": identityToken } });
    if (!res.ok) {
      log.warn({ status: res.status }, "secret broker fetch failed");
      return {};
    }
    const body = (await res.json()) as { secrets?: Record<string, string> };
    return body.secrets ?? {};
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "secret broker unreachable");
    return {};
  }
}
