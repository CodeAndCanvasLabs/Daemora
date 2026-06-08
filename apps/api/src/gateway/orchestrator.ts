/**
 * In-process tenant orchestrator for the single-ingress gateway.
 *
 * The gateway (apps/api) runs the TenantManager itself instead of talking to
 * a separate control-plane service. Local runtime spawns tenant child
 * processes; fly runtime spawns Fly Machines. Constructed in startApi() only
 * (never in buildApp / tests) so the test suite stays free of native + Fly deps.
 *
 * Imports reach into the main daemora source tree (../../../../src) — tsx
 * resolves these at runtime; this file is not part of the tsc src project.
 */

import { eq } from "drizzle-orm";
import type postgres from "postgres";

import { MasterKeyVault } from "../../../../src/multitenant/MasterKeyVault.js";
import { TenantManager } from "../../../../src/multitenant/TenantManager.js";
import { FlyMachinesClient } from "../../../../src/multitenant/FlyMachinesClient.js";
import { FlyMachinesRuntime, type TenantRuntime } from "../../../../src/multitenant/TenantRuntime.js";
import type { Env } from "../lib/env.js";
import type { DB } from "../db/client.js";
import { tenants } from "../db/schema.js";
import { loadConfig } from "../routes/config.js";

/**
 * Build the orchestrator from env. Throws if MASTER_KEK is missing (fail loud).
 * When `db` is provided, the orchestrator delivers each tenant its central
 * (Postgres) config at boot — so config is sourced from Postgres, not the
 * tenant's machine SQLite (which becomes a read-cache).
 */
export function buildOrchestrator(env: Env, sql: postgres.Sql, db?: DB): TenantManager {
  const masterVault = MasterKeyVault.fromEnv();
  const runtime = pickRuntime(env);
  const bootConfigProvider = db ? (slug: string) => loadConfigBySlug(db, slug) : undefined;
  return new TenantManager({
    dataRoot: env.DAEMORA_DATA_DIR,
    sql,                                 // Postgres-backed registry (#25)
    masterVault,
    ...(runtime ? { runtime } : {}),
    ...(bootConfigProvider ? { bootConfigProvider } : {}),
  });
}

/** slug → userId (Postgres tenants) → that user's central config (tenant_settings). */
async function loadConfigBySlug(db: DB, slug: string): Promise<Record<string, unknown>> {
  const rows = await db.select({ userId: tenants.userId }).from(tenants).where(eq(tenants.slug, slug)).limit(1);
  const userId = rows[0]?.userId;
  if (!userId) return {};
  return loadConfig(db, userId);
}

/** undefined → LocalChildProcessRuntime (default). 'fly' → FlyMachinesRuntime. */
function pickRuntime(env: Env): TenantRuntime | undefined {
  if (env.DAEMORA_RUNTIME !== "fly") return undefined;
  const missing = (["FLY_API_TOKEN", "FLY_TENANT_APP_NAME", "FLY_TENANT_IMAGE"] as const)
    .filter((k) => !env[k]);
  if (missing.length) throw new Error(`DAEMORA_RUNTIME=fly requires: ${missing.join(", ")}`);
  const client = new FlyMachinesClient({
    apiToken: env.FLY_API_TOKEN!,
    tenantAppName: env.FLY_TENANT_APP_NAME!,
    region: env.FLY_REGION,
    tenantImage: env.FLY_TENANT_IMAGE!,
  });
  return new FlyMachinesRuntime({ client, tenantAppName: env.FLY_TENANT_APP_NAME! });
}
