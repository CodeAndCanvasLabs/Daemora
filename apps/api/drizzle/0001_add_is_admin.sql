-- Adds users.is_admin so /billing/admin/* routes can be gated by user
-- role instead of a static bearer token. Defaults to false; promote a
-- specific user with:
--   UPDATE users SET is_admin = true WHERE email = 'you@example.com';

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_admin" boolean NOT NULL DEFAULT false;
