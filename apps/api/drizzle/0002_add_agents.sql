-- Central agent roster (multi-agent). A user's named agents, each bound to a
-- profile. Durable account-level list that survives tenant-machine loss and
-- powers plan-tiered agent limits (free/trial=1, lite/pro=5, enterprise=25)
-- and the "roster of workers" UI. Per-tenant chat/memory stay on the machine.
-- A user can have several agents (even sharing a profile) → user_id is indexed,
-- not unique.

CREATE TABLE IF NOT EXISTS "agents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "profile_id" text NOT NULL,
  "name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "agents_user_idx" ON "agents" ("user_id");
