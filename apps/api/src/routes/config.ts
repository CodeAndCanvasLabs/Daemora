/**
 * /api/me/config — the ONE unified config endpoint (central Postgres).
 *
 *   GET  /api/me/config   → { config: { KEY: value, … } }  the authed user's saved config
 *   PUT  /api/me/config   → upsert a PARTIAL config object; returns the merged result
 *
 * This replaces the tenant's scattered save endpoints (/api/settings,
 * /api/settings/:key, /api/security/fs, …). General (non-secret) config now
 * lives in `tenant_settings` keyed by user — the single source of truth — and is
 * delivered to the tenant at boot via the orchestrator's bootConfigProvider, so
 * settings survive machine recreation and never silently revert. Secrets stay on
 * the separate encrypted path (tenant_api_keys / vault), never here.
 */

import { Hono, type Context } from "hono";
import { eq, and } from "drizzle-orm";

import type { Auth } from "../auth/auth.js";
import type { DB } from "../db/client.js";
import { tenants, tenantSettings, type User } from "../db/schema.js";
import { signIdentity } from "../../../../src/multitenant/identityToken.js";

/** Just enough of the orchestrator to find a running tenant's upstream URL. */
export interface TenantUpstream {
  getUpstreamUrl(slug: string): string | undefined;
}

export interface ConfigRoutesDeps {
  readonly db: DB;
  readonly auth: Auth;
  /** When set, config changes are pushed to the running tenant so they apply live. */
  readonly manager?: TenantUpstream;
  readonly signingSecret?: string;
}

// Secrets must never flow through this non-secret config channel. Anything
// matching these patterns is rejected (use the vault / secret broker instead).
const SECRET_KEY = /(KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|CREDENTIAL)$/i;

export function buildConfigRoutes(deps: ConfigRoutesDeps): Hono {
  const app = new Hono();

  // GET /api/me/config — the user's saved config map.
  app.get("/config", async (c) => {
    const user = await requireUser(c, deps);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    return c.json({ config: await loadConfig(deps.db, user.id) });
  });

  // PUT /api/me/config — partial upsert. Body: { KEY: value, … }.
  app.put("/config", async (c) => {
    const user = await requireUser(c, deps);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "invalid_body", detail: "expected a JSON object of { key: value }" }, 400);
    }

    const rejected = Object.keys(body).filter((k) => SECRET_KEY.test(k));
    if (rejected.length) {
      return c.json(
        { error: "secret_not_allowed", detail: `Secrets go through the vault, not config: ${rejected.join(", ")}` },
        400,
      );
    }

    for (const [key, value] of Object.entries(body)) {
      await deps.db
        .insert(tenantSettings)
        .values({ userId: user.id, key, value: value as never })
        .onConflictDoUpdate({
          target: [tenantSettings.userId, tenantSettings.key],
          set: { value: value as never, updatedAt: new Date() },
        });
    }

    // Live-apply: push to the running tenant so changes take effect without a
    // restart. Best-effort — if the tenant is asleep it picks them up at boot.
    await applyToRunningTenant(deps, user.id, body);

    return c.json({ config: await loadConfig(deps.db, user.id) });
  });

  // DELETE /api/me/config/:key — reset one key to its default (remove override).
  app.delete("/config/:key", async (c) => {
    const user = await requireUser(c, deps);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const key = c.req.param("key");
    await deps.db
      .delete(tenantSettings)
      .where(and(eq(tenantSettings.userId, user.id), eq(tenantSettings.key, key)));
    return c.json({ config: await loadConfig(deps.db, user.id) });
  });

  return app;
}

/** Load a user's full config map from Postgres. */
export async function loadConfig(db: DB, userId: string): Promise<Record<string, unknown>> {
  const rows = await db
    .select({ key: tenantSettings.key, value: tenantSettings.value })
    .from(tenantSettings)
    .where(eq(tenantSettings.userId, userId));
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** Push a config change to the user's running tenant (signed). Best-effort. */
async function applyToRunningTenant(deps: ConfigRoutesDeps, userId: string, config: Record<string, unknown>): Promise<void> {
  if (!deps.manager || !deps.signingSecret) return;
  try {
    const rows = await deps.db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.userId, userId)).limit(1);
    const slug = rows[0]?.slug;
    if (!slug) return;
    const upstream = deps.manager.getUpstreamUrl(slug);
    if (!upstream) return; // not running — it'll re-seed from Postgres at next boot
    await fetch(`${upstream}/internal/config`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-daemora-user": signIdentity(deps.signingSecret, userId, slug),
      },
      body: JSON.stringify(config),
    });
  } catch {
    /* best-effort: a failed live push just means the change applies at next boot */
  }
}

async function requireUser(c: Context, deps: ConfigRoutesDeps): Promise<User | null> {
  const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
  return (session?.user ?? null) as User | null;
}
