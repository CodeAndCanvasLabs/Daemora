-- Central source of truth for a user's GENERAL (non-secret) config: DEFAULT_MODEL,
-- model prefs, FS guard, cost caps, heartbeat, etc. One row per (user, key); value
-- is JSON. Delivered to the tenant at boot via the broker, so the tenant's machine
-- SQLite settings_entries becomes a read-cache — config survives machine recreation
-- and never silently reverts. Secrets stay in tenant_api_keys (encrypted); this
-- table holds non-secret config only.

CREATE TABLE IF NOT EXISTS "tenant_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "value" jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_settings_user_key_idx" ON "tenant_settings" ("user_id", "key");
