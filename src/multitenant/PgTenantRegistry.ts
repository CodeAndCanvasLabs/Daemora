/**
 * PgTenantRegistry — Postgres-backed registry of all tenants (#25).
 *
 * Replaces the old SQLite `tenants.db` file. Postgres is the durable source of
 * truth; an in-memory cache (hydrated once at boot) serves the hot read path so
 * request routing (getUpstreamUrl / findBySlug) stays synchronous and fast with
 * no per-request network round-trip. Writes go to Postgres first (awaited) then
 * update the cache, so a process restart re-hydrates the exact persisted state —
 * correct for both the long-lived gateway and the short-lived operator CLI.
 *
 * Tables (see drizzle/0005_tenant_registry.sql): tenant_registry,
 * tenant_registry_config, tenant_registry_events. Kept separate from the
 * control-plane `tenants` table (user_id-keyed) so this is a pure
 * storage-location move with no signup/provision refactor.
 *
 * API keys: the old SQLite table was always empty — real BYOK secrets live in
 * the user_id-keyed `tenant_api_keys` table and are delivered via the gateway
 * broker. So this registry exposes no-op/empty api-key methods.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type postgres from "postgres";

import { createLogger } from "../util/logger.js";
import { ValidationError } from "../util/errors.js";
import { planConfigEntries } from "./plans.js";
import {
  type CreateTenantInput,
  type Plan,
  type Tenant,
  type TenantApiKeyRow,
  type TenantEvent,
  type TenantStatus,
} from "./types.js";

const log = createLogger("multitenant.registry");

const PORT_FLOOR = 8101;
const PORT_CEILING = 8999;
const EVENT_RING = 50;

interface TenantRow {
  id: string;
  slug: string;
  email: string;
  plan: string;
  status: string;
  data_dir: string;
  port: number;
  created_at: Date | string;
  suspended_at: Date | string | null;
  suspend_reason: string | null;
  deleted_at: Date | string | null;
}

/** postgres.js may hand back timestamptz as a Date or an ISO string depending on
 *  the connection's type parsing — normalise both to an ISO string. */
function toIso(v: Date | string | null | undefined): string | undefined {
  if (v == null) return undefined;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function rowToTenant(row: TenantRow): Tenant {
  const suspendedAt = toIso(row.suspended_at);
  const deletedAt = toIso(row.deleted_at);
  return {
    id: row.id,
    slug: row.slug,
    email: row.email,
    plan: row.plan as Plan,
    status: row.status as TenantStatus,
    dataDir: row.data_dir,
    port: row.port,
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
    ...(suspendedAt ? { suspendedAt } : {}),
    ...(row.suspend_reason ? { suspendReason: row.suspend_reason } : {}),
    ...(deletedAt ? { deletedAt } : {}),
  };
}

export class PgTenantRegistry {
  private readonly sql: postgres.Sql;
  private hydrated = false;
  /** slug → tenant (the durable runtime view). */
  private readonly tenants = new Map<string, Tenant>();
  /** slug → per-tenant config overrides (plan-derived values are computed). */
  private readonly overrides = new Map<string, Map<string, unknown>>();
  /** tenantId → recent events (in-memory ring; informational). */
  private readonly events = new Map<string, TenantEvent[]>();

  constructor(sql: postgres.Sql) {
    this.sql = sql;
  }

  /** Load all tenants + config overrides into the cache. Call once at boot. */
  async hydrate(): Promise<void> {
    const rows = (await this.sql`SELECT * FROM tenant_registry`) as unknown as TenantRow[];
    this.tenants.clear();
    for (const r of rows) this.tenants.set(r.slug, rowToTenant(r));
    const cfg = (await this.sql`SELECT tr.slug, c.key, c.value FROM tenant_registry_config c
      JOIN tenant_registry tr ON tr.id = c.tenant_id`) as unknown as Array<{ slug: string; key: string; value: unknown }>;
    this.overrides.clear();
    for (const c of cfg) {
      let m = this.overrides.get(c.slug);
      if (!m) { m = new Map(); this.overrides.set(c.slug, m); }
      m.set(c.key, c.value);
    }
    this.hydrated = true;
    log.info({ tenants: this.tenants.size }, "tenant registry hydrated from Postgres");
  }

  private ensureHydrated(): void {
    if (!this.hydrated) throw new Error("PgTenantRegistry used before hydrate()");
  }

  /** No shared-pool teardown here — the caller owns the postgres client. */
  async close(): Promise<void> { /* shared client; nothing to close */ }

  // ── tenant lifecycle ─────────────────────────────────────────────

  async create(input: CreateTenantInput, dataRoot: string): Promise<Tenant> {
    this.ensureHydrated();
    const slug = input.slug ?? slugify(input.email);
    if (this.tenants.has(slug)) throw new ValidationError(`tenant slug already exists: ${slug}`);
    if ([...this.tenants.values()].some((t) => t.email === input.email)) {
      throw new ValidationError(`tenant email already exists: ${input.email}`);
    }
    const id = randomUUID();
    const port = this.nextPort();
    const dataDir = join(dataRoot, "tenants", slug);
    const now = new Date();

    await this.sql`INSERT INTO tenant_registry (id, slug, email, plan, status, data_dir, port, created_at)
      VALUES (${id}, ${slug}, ${input.email}, ${input.plan}, ${"provisioning"}, ${dataDir}, ${port}, ${now})`;

    const tenant: Tenant = {
      id, slug, email: input.email, plan: input.plan, status: "provisioning",
      dataDir, port, createdAt: now.toISOString(),
    };
    this.tenants.set(slug, tenant);
    await this.appendEvent(id, "created", `plan=${input.plan} slug=${slug}`);
    return tenant;
  }

  async setStatus(slug: string, status: TenantStatus, reason?: string): Promise<void> {
    const t = this.requireBySlug(slug);
    const now = new Date();
    const suspendedAt = status === "suspended" ? now : (t.suspendedAt ? new Date(t.suspendedAt) : null);
    const suspendReason = status === "suspended" ? (reason ?? null) : (t.suspendReason ?? null);
    const deletedAt = status === "archived" ? now : (t.deletedAt ? new Date(t.deletedAt) : null);
    await this.sql`UPDATE tenant_registry
      SET status = ${status}, suspended_at = ${suspendedAt}, suspend_reason = ${suspendReason}, deleted_at = ${deletedAt}
      WHERE id = ${t.id}`;
    this.tenants.set(slug, {
      ...t, status,
      ...(suspendedAt ? { suspendedAt: suspendedAt.toISOString() } : {}),
      ...(suspendReason ? { suspendReason } : {}),
      ...(deletedAt ? { deletedAt: deletedAt.toISOString() } : {}),
    });
    await this.appendEvent(t.id, status, reason ?? "");
  }

  async setPlan(slug: string, plan: Plan): Promise<void> {
    const t = this.requireBySlug(slug);
    await this.sql`UPDATE tenant_registry SET plan = ${plan} WHERE id = ${t.id}`;
    this.tenants.set(slug, { ...t, plan });
    await this.appendEvent(t.id, "plan_changed", `plan=${plan}`);
  }

  async hardDelete(slug: string): Promise<void> {
    const t = this.requireBySlug(slug);
    await this.sql`DELETE FROM tenant_registry WHERE id = ${t.id}`; // config cascades
    this.tenants.delete(slug);
    this.overrides.delete(slug);
    this.events.delete(t.id);
  }

  // ── reads (sync from cache) ──────────────────────────────────────

  list(filter?: { status?: TenantStatus }): Tenant[] {
    this.ensureHydrated();
    const all = [...this.tenants.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return filter?.status ? all.filter((t) => t.status === filter.status) : all;
  }

  findBySlug(slug: string): Tenant | undefined {
    this.ensureHydrated();
    return this.tenants.get(slug);
  }

  findByEmail(email: string): Tenant | undefined {
    this.ensureHydrated();
    return [...this.tenants.values()].find((t) => t.email === email);
  }

  findByPort(port: number): Tenant | undefined {
    this.ensureHydrated();
    return [...this.tenants.values()].find((t) => t.port === port);
  }

  requireBySlug(slug: string): Tenant {
    const t = this.findBySlug(slug);
    if (!t) throw new ValidationError(`unknown tenant: ${slug}`);
    return t;
  }

  // ── config (plan-derived + operator overrides) ───────────────────

  async setConfig(slug: string, key: string, value: unknown): Promise<void> {
    const t = this.requireBySlug(slug);
    await this.sql`INSERT INTO tenant_registry_config (tenant_id, key, value, updated_at)
      VALUES (${t.id}, ${key}, ${this.sql.json(value as never)}, ${new Date()})
      ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
    let m = this.overrides.get(slug);
    if (!m) { m = new Map(); this.overrides.set(slug, m); }
    m.set(key, value);
  }

  getConfig(slug: string, key: string): unknown {
    return this.getAllConfig(slug)[key];
  }

  getAllConfig(slug: string): Record<string, unknown> {
    const t = this.requireBySlug(slug);
    const out: Record<string, unknown> = {};
    for (const e of planConfigEntries(t.plan)) out[e.key] = e.value; // derived from plan
    const ov = this.overrides.get(slug);                            // operator overrides win
    if (ov) for (const [k, v] of ov) out[k] = v;
    return out;
  }

  // ── api keys (no-op: real secrets live in the user_id-keyed broker) ──

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async putApiKey(_slug: string, _keyName: string, _ciphertext: Buffer, _nonce: Buffer): Promise<void> {
    throw new ValidationError("registry api-key storage is disabled — store BYOK secrets via the gateway (central tenant_api_keys)");
  }
  getApiKey(_slug: string, _keyName: string): TenantApiKeyRow | undefined { return undefined; }
  listApiKeyNames(_slug: string): string[] { return []; }
  async deleteApiKey(_slug: string, _keyName: string): Promise<void> { /* nothing stored here */ }
  getAllApiKeys(_slug: string): TenantApiKeyRow[] { return []; }

  // ── events ───────────────────────────────────────────────────────

  async appendEvent(tenantId: string, kind: string, detail?: string): Promise<void> {
    const at = new Date();
    try {
      await this.sql`INSERT INTO tenant_registry_events (tenant_id, kind, detail, at)
        VALUES (${tenantId}, ${kind}, ${detail ?? null}, ${at})`;
    } catch (err) {
      log.warn({ tenantId, kind, err: (err as Error).message }, "event insert failed (non-fatal)");
    }
    const ring = this.events.get(tenantId) ?? [];
    ring.unshift({ id: ring.length, tenantId, kind, ...(detail ? { detail } : {}), at: at.toISOString() });
    this.events.set(tenantId, ring.slice(0, EVENT_RING));
  }

  recentEvents(slug: string, limit = 20): TenantEvent[] {
    const t = this.requireBySlug(slug);
    return (this.events.get(t.id) ?? []).slice(0, limit);
  }

  // ── internals ────────────────────────────────────────────────────

  private nextPort(): number {
    const used = new Set<number>([...this.tenants.values()].map((t) => t.port));
    for (let p = PORT_FLOOR; p <= PORT_CEILING; p++) if (!used.has(p)) return p;
    throw new Error(`exhausted tenant port range ${PORT_FLOOR}-${PORT_CEILING}`);
  }
}

function slugify(email: string): string {
  const base = email
    .toLowerCase()
    .replace(/@/g, "-at-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return base.length >= 2 ? base : `tenant-${Date.now()}`;
}
