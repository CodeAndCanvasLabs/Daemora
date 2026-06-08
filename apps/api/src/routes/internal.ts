/**
 * /internal/* — gateway→tenant internal API (NOT user-facing).
 *
 * GET /internal/secrets — the secret broker. A booting tenant calls this with
 * its signed `X-Daemora-User` identity (minted by the gateway) and receives its
 * decrypted BYOK secrets, which it holds IN-MEMORY — so secrets never live in
 * the tenant machine's disk or env (threat T6).
 *
 * Auth is the signed identity ONLY (no user session): the gateway signs a
 * short-lived token into the tenant's boot env; the tenant presents it here.
 */

import { Hono, type Context } from "hono";

import { verifyIdentity } from "../../../../src/multitenant/identityToken.js";

/** Minimal surface this route needs from the in-process TenantManager. */
export interface SecretSource {
  getDecryptedSecrets(slug: string): Record<string, string>;
}

export interface InternalRoutesDeps {
  readonly manager: SecretSource;
  readonly signingSecret?: string;
}

export function buildInternalRoutes(deps: InternalRoutesDeps): Hono {
  const app = new Hono();

  app.get("/secrets", (c) => {
    if (!deps.signingSecret) return c.json({ error: "broker_disabled" }, 503);
    const id = verifiedIdentity(c, deps.signingSecret);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    // Never log the values.
    return c.json({ secrets: deps.manager.getDecryptedSecrets(id.slug) });
  });

  return app;
}

function verifiedIdentity(c: Context, secret: string): { userId: string; slug: string } | null {
  const header = c.req.header("x-daemora-user");
  return header ? verifyIdentity(secret, header) : null;
}
