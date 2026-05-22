/**
 * `daemora control-plane start` — runs the multi-tenant orchestrator
 * + reverse proxy on $CONTROL_PLANE_PORT (default 8080).
 *
 * Reads:
 *   DAEMORA_DATA_DIR              data root (tenants live in <root>/tenants/)
 *   MASTER_KEK                    required for per-tenant API key encryption
 *   CONTROL_PLANE_PORT            default 8080
 *   CONTROL_PLANE_ADMIN_TOKEN     bearer for /admin/* (optional; admin disabled if unset)
 *   CONTROL_PLANE_HOST_SUFFIX     e.g. ".daemora.app" for subdomain routing
 */

import { readBootEnv } from "../../config/env.js";
import { FlyMachinesClient } from "../../multitenant/FlyMachinesClient.js";
import { MasterKeyVault } from "../../multitenant/MasterKeyVault.js";
import { TenantManager } from "../../multitenant/TenantManager.js";
import { FlyMachinesRuntime, type TenantRuntime } from "../../multitenant/TenantRuntime.js";
import { signalOrphaned, signalTree } from "../../util/killTree.js";
import { createLogger } from "../../util/logger.js";
import { startControlPlane } from "../../multitenant/controlPlane.js";

const log = createLogger("cli.controlPlane");

function pickRuntime(): TenantRuntime | undefined {
  const mode = (process.env["DAEMORA_RUNTIME"] ?? "local").toLowerCase();
  if (mode !== "fly") return undefined;                       // default = LocalChildProcessRuntime

  const apiToken      = process.env["FLY_API_TOKEN"];
  const tenantAppName = process.env["FLY_TENANT_APP_NAME"];
  const region        = process.env["FLY_REGION"] ?? "iad";
  const tenantImage   = process.env["FLY_TENANT_IMAGE"];
  const missing = Object.entries({ FLY_API_TOKEN: apiToken, FLY_TENANT_APP_NAME: tenantAppName, FLY_TENANT_IMAGE: tenantImage })
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(`DAEMORA_RUNTIME=fly requires: ${missing.join(", ")}`);
  }
  const client = new FlyMachinesClient({
    apiToken: apiToken!,
    tenantAppName: tenantAppName!,
    region,
    tenantImage: tenantImage!,
  });
  log.info({ tenantAppName, region, tenantImage }, "Fly runtime active");
  return new FlyMachinesRuntime({ client, tenantAppName: tenantAppName! });
}

export async function controlPlaneCommand(args: string[]): Promise<void> {
  const [sub] = args;
  if (sub !== "start") {
    console.log(`daemora control-plane — multi-tenant orchestrator

  start    boot the control plane on $CONTROL_PLANE_PORT (default 8080)

Env vars:
  DAEMORA_DATA_DIR              required — where tenants/ lives
  MASTER_KEK                    required — base64 32 bytes; encrypts per-tenant API keys
  CONTROL_PLANE_PORT            default 8080
  CONTROL_PLANE_ADMIN_TOKEN     required to enable /admin/* (bearer)
  CONTROL_PLANE_HOST_SUFFIX     e.g. ".daemora.app" — for subdomain routing`);
    return;
  }

  const env = readBootEnv();
  const masterVault = MasterKeyVault.fromEnv();   // throws if MASTER_KEK missing — fail loud

  const port = Number(process.env["CONTROL_PLANE_PORT"] ?? 8080);
  const adminToken = process.env["CONTROL_PLANE_ADMIN_TOKEN"];
  const hostSuffix = process.env["CONTROL_PLANE_HOST_SUFFIX"];

  const runtime = pickRuntime();
  const manager = new TenantManager({
    dataRoot: env.dataDir,
    masterVault,
    ...(runtime ? { runtime } : {}),
  });

  const cp = startControlPlane({
    port,
    manager,
    ...(hostSuffix ? { hostSuffix } : {}),
    ...(adminToken ? { adminToken } : {}),
  });

  log.info({
    port,
    dataDir: env.dataDir,
    adminEnabled: Boolean(adminToken),
    hostSuffix: hostSuffix ?? "(unset — subdomain routing disabled)",
    tenants: manager.list().length,
  }, "control plane ready");

  const installRoot = new URL("../../../", import.meta.url).pathname;
  const shutdown = (signal: NodeJS.Signals): void => {
    log.info({ signal }, "control plane shutting down");
    process.exitCode = 0;
    // Stop every tenant child, then close the HTTP server.
    void (async () => {
      try {
        await manager.shutdown();
      } finally {
        await cp.close();
        manager.close();
        const sigtermed = signalTree(process.pid, "SIGTERM");
        if (sigtermed > 0) log.info({ count: sigtermed }, "SIGTERM sent to descendants");
        const orphTermed = signalOrphaned(installRoot, env.dataDir, "SIGTERM");
        if (orphTermed > 0) log.info({ count: orphTermed }, "SIGTERM sent to reparented orphans");
        setTimeout(() => {
          const k = signalTree(process.pid, "SIGKILL");
          if (k > 0) log.warn({ count: k }, "SIGKILL sent to survivors");
          const ok = signalOrphaned(installRoot, env.dataDir, "SIGKILL");
          if (ok > 0) log.warn({ count: ok }, "SIGKILL sent to orphan survivors");
          process.exit(0);
        }, 3_000).unref();
      }
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
