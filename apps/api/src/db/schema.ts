/**
 * Drizzle schema for the SaaS control DB (Neon Postgres).
 *
 * This is SEPARATE from each tenant's per-machine SQLite. This DB holds:
 *  - user identities, sessions, OAuth links
 *  - subscriptions + payment claims (Contra)
 *  - tenant ↔ user mapping + Fly Machine metadata
 *  - audit log of sensitive actions
 *
 * Per-tenant chat/wiki/vault data lives inside each tenant's own
 * SQLite + filesystem on their Fly Machine — never touched by this DB.
 */

import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ── users ────────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name"),
    image: text("image"),
    emailVerified: boolean("email_verified").notNull().default(false),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    hadTrial: boolean("had_trial").notNull().default(false),
    isAdmin: boolean("is_admin").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => ({
    emailIdx: uniqueIndex("users_email_idx").on(t.email),
  }),
);

// Better Auth wants these tables exactly (drizzle adapter). We mirror
// its names so the adapter Just Works.

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull(),                    // session token
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenIdx: uniqueIndex("sessions_token_idx").on(t.token),
    userIdx: index("sessions_user_idx").on(t.userId),
  }),
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),         // 'credential' | 'google' | 'github' | 'magic-link'
    accountId: text("account_id").notNull(),           // provider's user id
    password: text("password"),                        // argon2 hash (credential provider only)
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    idToken: text("id_token"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    providerIdx: uniqueIndex("accounts_provider_idx").on(t.providerId, t.accountId),
  }),
);

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    identifier: text("identifier").notNull(),          // email
    value: text("value").notNull(),                    // verification token (hashed)
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    identifierIdx: index("verifications_identifier_idx").on(t.identifier),
  }),
);

// ── subscriptions ────────────────────────────────────────────────

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    plan: text("plan").notNull(),                        // 'trial' | 'lite' | 'pro'
    status: text("status").notNull(),                    // 'trialing' | 'active' | 'past_due' | 'canceled' | 'expired'
    trialStartsAt: timestamp("trial_starts_at", { withTimezone: true }),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    currentPeriodStartsAt: timestamp("current_period_starts_at", { withTimezone: true }),
    currentPeriodEndsAt: timestamp("current_period_ends_at", { withTimezone: true }),
    externalProvider: text("external_provider").notNull(),   // 'contra' for v1
    externalId: text("external_id"),                          // contra subscription / transaction id
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("subs_user_idx").on(t.userId),
    statusIdx: index("subs_status_idx").on(t.status),
    trialEndIdx: index("subs_trial_end_idx").on(t.trialEndsAt),
  }),
);

// ── payment claims (Flow B — manual reconciliation) ──────────────

export const paymentClaims = pgTable(
  "payment_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id").notNull(),
    plan: text("plan").notNull(),                          // claimed plan
    status: text("status").notNull(),                      // 'pending' | 'confirmed' | 'rejected'
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedBy: uuid("confirmed_by"),                     // operator user id
  },
  (t) => ({
    userIdx: index("claims_user_idx").on(t.userId),
    statusIdx: index("claims_status_idx").on(t.status),
    txIdx: uniqueIndex("claims_tx_idx").on(t.transactionId),
  }),
);

// ── tenant ↔ user link + Fly Machine metadata ────────────────────

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    flyApp: text("fly_app"),                               // tenant Fly app, e.g. daemora-tenants
    flyMachineId: text("fly_machine_id"),
    flyVolumeId: text("fly_volume_id"),
    status: text("status").notNull(),                      // 'provisioning' | 'running' | 'sleeping' | 'suspended' | 'archived'
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: uniqueIndex("tenants_user_idx").on(t.userId),   // one tenant per user
    slugIdx: uniqueIndex("tenants_slug_idx").on(t.slug),
    statusIdx: index("tenants_status_idx").on(t.status),
  }),
);

// ── audit log ────────────────────────────────────────────────────

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id"),
    kind: text("kind").notNull(),                          // 'signup' | 'login' | 'plan_change' | …
    detail: jsonb("detail"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("audit_user_idx").on(t.userId),
    kindIdx: index("audit_kind_idx").on(t.kind),
    atIdx: index("audit_at_idx").on(t.at),
  }),
);

// Type exports — useful in services + routes.
export type Plan = "trial" | "lite" | "pro";
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type PaymentClaim = typeof paymentClaims.$inferSelect;
export type NewPaymentClaim = typeof paymentClaims.$inferInsert;
export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;

// Helper to embed a SQL fragment idempotently.
export const NOW = sql`now()`;
