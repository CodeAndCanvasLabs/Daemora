/**
 * TenantProvisioner — the narrow port the signup + trial flows use to create
 * and suspend tenants. Two implementations satisfy it structurally:
 *   - ControlPlaneClient (legacy split control plane)
 *   - the in-process TenantManager (single-ingress gateway, Option 1)
 *
 * Keeping it a tiny interface lets tests inject either without change.
 */

import type { TenantManager } from "../../../../src/multitenant/TenantManager.js";

export interface TenantProvisioner {
  provision(args: { email: string; plan: "trial" | "lite" | "pro"; slug?: string }): Promise<{ slug: string }>;
  suspend(slug: string, reason: string): Promise<unknown>;
}

/** In-process provisioner backed by the gateway's own TenantManager. */
export function managerProvisioner(manager: TenantManager): TenantProvisioner {
  return {
    async provision({ email, plan, slug }) {
      const tenant = await manager.create({ email, plan, ...(slug ? { slug } : {}) });
      await manager.start(tenant.slug);
      return { slug: tenant.slug };
    },
    suspend(slug, reason) {
      return manager.suspend(slug, reason);
    },
  };
}
