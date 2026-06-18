/**
 * Authenticated tenant resolution — the heart of the single-ingress gateway.
 *
 * SECURITY (closes the tenant-isolation hole): the tenant a request is routed
 * to is ALWAYS the authenticated user's own tenant, looked up from Postgres by
 * the Better Auth session. There is NO client-supplied slug/header/JWT — a
 * caller can only ever reach their own instance, so forging is impossible.
 *
 * Returns null when unauthenticated (→ gateway responds 401) or when the user
 * has no tenant yet (→ 402 / onboarding).
 */

import { eq } from "drizzle-orm";

import type { Auth } from "../auth/auth.js";
import type { DB } from "../db/client.js";
import { tenants } from "../db/schema.js";

export interface ResolveDeps {
  readonly db: DB;
  readonly auth: Auth;
}

export interface ResolvedTenant {
  readonly userId: string;
  readonly slug: string;
  readonly status: string;
}

/**
 * Resolve the authenticated caller's tenant from request headers (the session
 * cookie). Single source of truth for who-owns-what at the gateway.
 */
export async function resolveAuthedTenant(deps: ResolveDeps, headers: Headers): Promise<ResolvedTenant | null> {
  const session = await deps.auth.api.getSession({ headers });
  const userId = session?.user?.id;
  if (!userId) return null;

  const rows = await deps.db
    .select({ slug: tenants.slug, status: tenants.status })
    .from(tenants)
    .where(eq(tenants.userId, userId))
    .limit(1);
  const t = rows[0];
  if (!t) return null;
  return { userId, slug: t.slug, status: t.status };
}
