/**
 * TenantStore — SQLite-backed registry of all tenants.
 *
 * Lives at `<root>/data/tenants.db`. Independent of any tenant's own
 * daemora.db — the control plane reads/writes this file; tenants don't
 * see it. Schema bootstrapped on first open.
 *
 * Concurrency: WAL mode, single-writer in practice (the control plane
 * process). CLI commands open the file briefly and close.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import { ValidationError } from "../util/errors.js";
import {
  type CreateTenantInput,
  type Plan,
  type Tenant,
  type TenantApiKeyRow,
  type TenantConfigEntry,
  type TenantEvent,
  type TenantStatus,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  email           TEXT NOT NULL UNIQUE,
  plan            TEXT NOT NULL,
  status          TEXT NOT NULL,
  data_dir        TEXT NOT NULL,
  port            INTEGER NOT NULL UNIQUE,
  created_at      TEXT NOT NULL,
  suspended_at    TEXT,
  suspend_reason  TEXT,
  deleted_at      TEXT
);

CREATE TABLE IF NOT EXISTS tenant_config (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS tenant_api_keys (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_name    TEXT NOT NULL,
  ciphertext  BLOB NOT NULL,
  nonce       BLOB NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key_name)
);

CREATE TABLE IF NOT EXISTS tenant_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  detail      TEXT,
  at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenant_events_tenant ON tenant_events(tenant_id, at DESC);
`;

const PORT_FLOOR = 8101;
const PORT_CEILING = 8999;

interface TenantRow {
  id: string;
  slug: string;
  email: string;
  plan: string;
  status: string;
  data_dir: string;
  port: number;
  created_at: string;
  suspended_at: string | null;
  suspend_reason: string | null;
  deleted_at: string | null;
}

function rowToTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    slug: row.slug,
    email: row.email,
    plan: row.plan as Plan,
    status: row.status as TenantStatus,
    dataDir: row.data_dir,
    port: row.port,
    createdAt: row.created_at,
    ...(row.suspended_at ? { suspendedAt: row.suspended_at } : {}),
    ...(row.suspend_reason ? { suspendReason: row.suspend_reason } : {}),
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
  };
}

export class TenantStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const fresh = !existsSync(dbPath);
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    if (fresh) {
      // First-time setup — nothing to migrate.
    }
  }

  close(): void {
    this.db.close();
  }

  // ── tenant lifecycle ─────────────────────────────────────────────

  create(input: CreateTenantInput, dataRoot: string): Tenant {
    const slug = input.slug ?? slugify(input.email);
    if (this.findBySlug(slug)) throw new ValidationError(`tenant slug already exists: ${slug}`);
    if (this.findByEmail(input.email)) throw new ValidationError(`tenant email already exists: ${input.email}`);

    const id = randomUUID();
    const port = this.nextPort();
    const dataDir = join(dataRoot, "tenants", slug);
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO tenants (id, slug, email, plan, status, data_dir, port, created_at)
         VALUES (?, ?, ?, ?, 'provisioning', ?, ?, ?)`,
      )
      .run(id, slug, input.email, input.plan, dataDir, port, now);

    this.appendEvent(id, "created", `plan=${input.plan} slug=${slug}`);

    return rowToTenant(this.db.prepare("SELECT * FROM tenants WHERE id = ?").get(id) as TenantRow);
  }

  setStatus(slug: string, status: TenantStatus, reason?: string): void {
    const now = new Date().toISOString();
    const tenant = this.requireBySlug(slug);
    const stmt = this.db.prepare(
      `UPDATE tenants
       SET status = ?,
           suspended_at = CASE WHEN ? = 'suspended' THEN ? ELSE suspended_at END,
           suspend_reason = CASE WHEN ? = 'suspended' THEN ? ELSE suspend_reason END,
           deleted_at = CASE WHEN ? IN ('archived') THEN ? ELSE deleted_at END
       WHERE id = ?`,
    );
    stmt.run(status, status, now, status, reason ?? null, status, now, tenant.id);
    this.appendEvent(tenant.id, status, reason ?? "");
  }

  setPlan(slug: string, plan: Plan): void {
    const tenant = this.requireBySlug(slug);
    this.db.prepare("UPDATE tenants SET plan = ? WHERE id = ?").run(plan, tenant.id);
    this.appendEvent(tenant.id, "plan_changed", `plan=${plan}`);
  }

  hardDelete(slug: string): void {
    const tenant = this.requireBySlug(slug);
    this.db.prepare("DELETE FROM tenants WHERE id = ?").run(tenant.id);
    // events / config / api_keys cascade via FK
  }

  // ── reads ────────────────────────────────────────────────────────

  list(filter?: { status?: TenantStatus }): Tenant[] {
    const rows = filter?.status
      ? (this.db.prepare("SELECT * FROM tenants WHERE status = ? ORDER BY created_at").all(filter.status) as TenantRow[])
      : (this.db.prepare("SELECT * FROM tenants ORDER BY created_at").all() as TenantRow[]);
    return rows.map(rowToTenant);
  }

  findBySlug(slug: string): Tenant | undefined {
    const row = this.db.prepare("SELECT * FROM tenants WHERE slug = ?").get(slug) as TenantRow | undefined;
    return row ? rowToTenant(row) : undefined;
  }

  findByEmail(email: string): Tenant | undefined {
    const row = this.db.prepare("SELECT * FROM tenants WHERE email = ?").get(email) as TenantRow | undefined;
    return row ? rowToTenant(row) : undefined;
  }

  findByPort(port: number): Tenant | undefined {
    const row = this.db.prepare("SELECT * FROM tenants WHERE port = ?").get(port) as TenantRow | undefined;
    return row ? rowToTenant(row) : undefined;
  }

  requireBySlug(slug: string): Tenant {
    const t = this.findBySlug(slug);
    if (!t) throw new ValidationError(`unknown tenant: ${slug}`);
    return t;
  }

  // ── config ───────────────────────────────────────────────────────

  setConfig(slug: string, key: string, value: unknown): void {
    const tenant = this.requireBySlug(slug);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tenant_config (tenant_id, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(tenant.id, key, JSON.stringify(value), now);
  }

  getConfig(slug: string, key: string): unknown {
    const tenant = this.requireBySlug(slug);
    const row = this.db
      .prepare("SELECT value FROM tenant_config WHERE tenant_id = ? AND key = ?")
      .get(tenant.id, key) as { value: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.value); } catch { return row.value; }
  }

  getAllConfig(slug: string): Record<string, unknown> {
    const tenant = this.requireBySlug(slug);
    const rows = this.db
      .prepare("SELECT key, value FROM tenant_config WHERE tenant_id = ?")
      .all(tenant.id) as Array<{ key: string; value: string }>;
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      try { out[row.key] = JSON.parse(row.value); } catch { out[row.key] = row.value; }
    }
    return out;
  }

  // ── api keys (raw — encryption handled by MasterKeyVault wrapper) ──

  putApiKey(slug: string, keyName: string, ciphertext: Buffer, nonce: Buffer): void {
    const tenant = this.requireBySlug(slug);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tenant_api_keys (tenant_id, key_name, ciphertext, nonce, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, key_name) DO UPDATE
           SET ciphertext = excluded.ciphertext,
               nonce = excluded.nonce,
               created_at = excluded.created_at`,
      )
      .run(tenant.id, keyName, ciphertext, nonce, now);
    this.appendEvent(tenant.id, "apikey_set", keyName);
  }

  getApiKey(slug: string, keyName: string): TenantApiKeyRow | undefined {
    const tenant = this.requireBySlug(slug);
    const row = this.db
      .prepare("SELECT * FROM tenant_api_keys WHERE tenant_id = ? AND key_name = ?")
      .get(tenant.id, keyName) as { tenant_id: string; key_name: string; ciphertext: Buffer; nonce: Buffer; created_at: string } | undefined;
    if (!row) return undefined;
    return {
      tenantId: row.tenant_id,
      keyName: row.key_name,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      createdAt: row.created_at,
    };
  }

  listApiKeyNames(slug: string): string[] {
    const tenant = this.requireBySlug(slug);
    const rows = this.db
      .prepare("SELECT key_name FROM tenant_api_keys WHERE tenant_id = ? ORDER BY key_name")
      .all(tenant.id) as Array<{ key_name: string }>;
    return rows.map((r) => r.key_name);
  }

  deleteApiKey(slug: string, keyName: string): void {
    const tenant = this.requireBySlug(slug);
    this.db.prepare("DELETE FROM tenant_api_keys WHERE tenant_id = ? AND key_name = ?").run(tenant.id, keyName);
    this.appendEvent(tenant.id, "apikey_deleted", keyName);
  }

  getAllApiKeys(slug: string): TenantApiKeyRow[] {
    const tenant = this.requireBySlug(slug);
    const rows = this.db
      .prepare("SELECT * FROM tenant_api_keys WHERE tenant_id = ?")
      .all(tenant.id) as Array<{ tenant_id: string; key_name: string; ciphertext: Buffer; nonce: Buffer; created_at: string }>;
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      keyName: r.key_name,
      ciphertext: r.ciphertext,
      nonce: r.nonce,
      createdAt: r.created_at,
    }));
  }

  // ── events ───────────────────────────────────────────────────────

  appendEvent(tenantId: string, kind: string, detail?: string): void {
    this.db
      .prepare("INSERT INTO tenant_events (tenant_id, kind, detail, at) VALUES (?, ?, ?, ?)")
      .run(tenantId, kind, detail ?? null, new Date().toISOString());
  }

  recentEvents(slug: string, limit = 20): TenantEvent[] {
    const tenant = this.requireBySlug(slug);
    const rows = this.db
      .prepare(
        "SELECT id, tenant_id, kind, detail, at FROM tenant_events WHERE tenant_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(tenant.id, limit) as Array<{ id: number; tenant_id: string; kind: string; detail: string | null; at: string }>;
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      kind: r.kind,
      ...(r.detail ? { detail: r.detail } : {}),
      at: r.at,
    }));
  }

  // ── internals ────────────────────────────────────────────────────

  private nextPort(): number {
    // Cheapest correct port allocator: scan, pick first free in range.
    // At our scale this is fine — N tenants is in the thousands at most
    // on one host, and we only allocate on tenant create.
    const used = new Set<number>(
      (this.db.prepare("SELECT port FROM tenants").all() as Array<{ port: number }>).map((r) => r.port),
    );
    for (let p = PORT_FLOOR; p <= PORT_CEILING; p++) {
      if (!used.has(p)) return p;
    }
    throw new Error(`exhausted tenant port range ${PORT_FLOOR}-${PORT_CEILING}`);
  }
}

function slugify(email: string): string {
  // Email → URL-safe slug. We lowercase, strip @, replace dots/+ with -,
  // and clamp length. Collisions are caught by the UNIQUE constraint.
  const base = email
    .toLowerCase()
    .replace(/@/g, "-at-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return base.length >= 2 ? base : `tenant-${Date.now()}`;
}
