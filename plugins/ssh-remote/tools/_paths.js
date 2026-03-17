/**
 * Tenant-aware temp/workspace directory helper.
 *
 * TENANT_ISOLATE_FILESYSTEM=true + tenant context active
 *   → data/tenants/{safeId}/workspace/{subdir}
 * Otherwise
 *   → os.tmpdir()/{subdir}
 *
 * Auto-creates the directory.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../../../src/config/default.js";
import tenantContext from "../../../src/tenants/TenantContext.js";

const TENANTS_DIR = join(config.dataDir, "tenants");

/**
 * @param {string} [subdir] - e.g. "daemora-images", "daemora-tts"
 * @returns {string} absolute directory path (already created)
 */
export function getTenantTmpDir(subdir) {
  const store = tenantContext.getStore();
  const tenantId = store?.tenant?.id;

  if (tenantId && config.multiTenant?.isolateFilesystem) {
    const safeId = tenantId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const dir = subdir
      ? join(TENANTS_DIR, safeId, "workspace", subdir)
      : join(TENANTS_DIR, safeId, "workspace");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  const dir = subdir ? join(tmpdir(), subdir) : tmpdir();
  if (subdir) mkdirSync(dir, { recursive: true });
  return dir;
}
