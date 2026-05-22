/**
 * Shared types for the multi-tenant control plane.
 *
 * A "tenant" is one user's daemora instance: their data dir, their
 * port, their plan, their secrets. The control plane owns the registry
 * and lifecycle; each tenant's daemora is a black box once spawned.
 */

import { z } from "zod";

export const TenantStatus = z.enum([
  "provisioning",   // dir created, not yet started
  "running",        // process up, accepting requests
  "sleeping",       // intentionally stopped; data preserved; can wake
  "suspended",      // operator-stopped (trial expired, fraud, support); cannot wake without admin
  "archived",       // volume snapshotted to cold storage; tenant gone
  "crashed",        // last seen exit was non-zero; control plane will retry
]);
export type TenantStatus = z.infer<typeof TenantStatus>;

export const Plan = z.enum(["trial", "lite", "pro"]);
export type Plan = z.infer<typeof Plan>;

export interface Tenant {
  readonly id: string;             // uuid
  readonly slug: string;           // url-safe; the subdomain
  readonly email: string;
  readonly plan: Plan;
  readonly status: TenantStatus;
  readonly dataDir: string;        // absolute path on the host
  readonly port: number;           // assigned local port (8101+ in dev)
  readonly createdAt: string;      // ISO
  readonly suspendedAt?: string;
  readonly suspendReason?: string;
  readonly deletedAt?: string;
}

export interface TenantConfigEntry {
  readonly tenantId: string;
  readonly key: string;
  readonly value: unknown;          // JSON-decoded
  readonly updatedAt: string;
}

export interface TenantEvent {
  readonly id: number;
  readonly tenantId: string;
  readonly kind: string;            // 'created' | 'started' | 'stopped' | 'suspended' | ...
  readonly detail?: string;
  readonly at: string;
}

export interface TenantApiKeyRow {
  readonly tenantId: string;
  readonly keyName: string;
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly createdAt: string;
}

/** What `TenantManager.show()` returns — full picture of a tenant. */
export interface TenantDetail {
  readonly tenant: Tenant;
  readonly config: Record<string, unknown>;
  readonly apiKeyNames: readonly string[];   // names only, never values
  readonly recentEvents: readonly TenantEvent[];
  readonly runtime?: {
    readonly pid: number;
    readonly uptimeMs: number;
  };
}

/** Schema for tenant create input. */
export const CreateTenantInput = z.object({
  email: z.string().email().max(254),
  plan: Plan.optional().default("trial"),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/).min(2).max(63).optional(),
});
export type CreateTenantInput = z.infer<typeof CreateTenantInput>;
