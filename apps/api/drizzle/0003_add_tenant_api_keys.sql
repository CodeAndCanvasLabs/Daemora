-- Central, encrypted BYOK store (crown jewels). A user's API keys live here,
-- encrypted with the master KEK + a per-user HKDF subkey, and are delivered to
-- the tenant IN-MEMORY at boot via the gateway secret broker — never written to
-- the tenant machine's disk or env (threat T6). key_version supports rotation.

CREATE TABLE IF NOT EXISTS "tenant_api_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "key_name" text NOT NULL,
  "ciphertext" text NOT NULL,
  "nonce" text NOT NULL,
  "key_version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_api_keys_user_key_idx" ON "tenant_api_keys" ("user_id", "key_name");
