-- #25 — move the orchestrator's tenant registry off the local SQLite file
-- (data/cloud-tenants/tenants.db) into Postgres. Dedicated tables, owned by the
-- TenantManager, mirroring the old SQLite schema 1:1 (minus the always-empty
-- tenant_api_keys — real secrets live in tenant_api_keys keyed by user_id and are
-- delivered via the gateway broker). Kept separate from the control-plane
-- `tenants` table (which is user_id-keyed) so this is a pure storage-location
-- move with no signup/provision refactor.

CREATE TABLE IF NOT EXISTS tenant_registry (
  id              uuid PRIMARY KEY,
  slug            text NOT NULL UNIQUE,
  email           text NOT NULL UNIQUE,
  plan            text NOT NULL,
  status          text NOT NULL,
  data_dir        text NOT NULL,
  port            integer NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  suspended_at    timestamptz,
  suspend_reason  text,
  deleted_at      timestamptz
);

CREATE TABLE IF NOT EXISTS tenant_registry_config (
  tenant_id   uuid NOT NULL REFERENCES tenant_registry(id) ON DELETE CASCADE,
  key         text NOT NULL,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS tenant_registry_events (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  kind        text NOT NULL,
  detail      text,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_registry_events_tenant
  ON tenant_registry_events(tenant_id, at DESC);
