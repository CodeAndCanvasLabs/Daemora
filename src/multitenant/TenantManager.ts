/**
 * TenantManager — lifecycle of tenant subprocesses (local) or Fly
 * Machines (cloud).
 *
 * In local dev (this file) we spawn a child `node dist/cli/index.js
 * start` per tenant, scoped to the tenant's data dir + port, with
 * FilesystemGuard in `sandbox` mode. The cloud port (phase 12) will
 * replace `spawn` with calls to Fly's Machines API but keep this same
 * interface so the rest of the system doesn't care.
 *
 * Isolation enforcement happens at spawn time:
 *  - env: DAEMORA_DATA_DIR / PORT / DAEMORA_FS_GUARD=sandbox / DAEMORA_FS_ALLOW
 *  - decrypted per-tenant API keys injected via env (just-in-time)
 *  - per-tenant vault passphrase injected via env
 *  - child registered in our PID map so shutdown reaps it cleanly
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger } from "../util/logger.js";
import { ValidationError } from "../util/errors.js";
import type { MasterKeyVault } from "./MasterKeyVault.js";
import { planConfigEntries } from "./plans.js";
import {
  LocalChildProcessRuntime,
  type StartedTenant,
  type TenantRuntime,
} from "./TenantRuntime.js";
import {
  type CreateTenantInput,
  type Plan,
  type Tenant,
  type TenantDetail,
  type TenantStatus,
} from "./types.js";
import { TenantStore } from "./TenantStore.js";

const log = createLogger("multitenant.manager");

interface RunningTenant {
  readonly slug: string;
  readonly upstreamUrl: string;       // local: http://127.0.0.1:<port>, fly: flycast URL
  readonly runtimeId: string;         // pid (local) or machine id (cloud)
  readonly port: number;
  readonly startedAt: number;
}

export interface TenantManagerOpts {
  readonly dataRoot: string;          // <root>/data
  readonly daemoraEntry?: string;     // path to dist/cli/index.js (auto-detected if absent)
  readonly masterVault?: MasterKeyVault;
  /** Override runtime — defaults to LocalChildProcessRuntime for back-compat. */
  readonly runtime?: TenantRuntime;
}

export class TenantManager {
  private readonly store: TenantStore;
  private readonly dataRoot: string;
  private readonly runtime: TenantRuntime;
  private readonly running = new Map<string, RunningTenant>();
  private readonly masterVault?: MasterKeyVault;

  constructor(opts: TenantManagerOpts) {
    this.dataRoot = opts.dataRoot;
    this.store = new TenantStore(join(opts.dataRoot, "tenants.db"));
    this.runtime = opts.runtime ?? new LocalChildProcessRuntime({
      daemoraEntry: opts.daemoraEntry ?? resolveDaemoraEntry(),
    });
    if (opts.masterVault) this.masterVault = opts.masterVault;
  }

  close(): void {
    this.store.close();
  }

  /** Underlying store for read paths that don't need orchestration. */
  get registry(): TenantStore {
    return this.store;
  }

  // ── create / read ────────────────────────────────────────────────

  async create(input: CreateTenantInput): Promise<Tenant> {
    const tenant = this.store.create(input, this.dataRoot);
    mkdirSync(tenant.dataDir, { recursive: true });
    // Skeleton subdirs the agent's own boot expects to find.
    for (const sub of ["wiki", "file-projects", "outputs", "custom-skills", "browser", "memory"]) {
      mkdirSync(join(tenant.dataDir, sub), { recursive: true });
    }
    // Apply the plan preset so new tenants have sensible caps from
    // turn 0 (without operator having to remember `tenant plan ...`).
    this.applyPlanPreset(tenant.slug, tenant.plan);
    log.info({ slug: tenant.slug, port: tenant.port, dataDir: tenant.dataDir, plan: tenant.plan }, "tenant created");
    return tenant;
  }

  list(filter?: { status?: TenantStatus }): Tenant[] {
    return this.store.list(filter);
  }

  get(slug: string): Tenant | undefined {
    return this.store.findBySlug(slug);
  }

  show(slug: string): TenantDetail {
    const tenant = this.store.requireBySlug(slug);
    const r = this.running.get(slug);
    return {
      tenant,
      config: this.store.getAllConfig(slug),
      apiKeyNames: this.store.listApiKeyNames(slug),
      recentEvents: this.store.recentEvents(slug, 10),
      ...(r ? { runtime: { id: r.runtimeId, uptimeMs: Date.now() - r.startedAt } } : {}),
    };
  }

  // ── config + plan + api keys ─────────────────────────────────────

  setPlan(slug: string, plan: Plan): void {
    this.store.setPlan(slug, plan);
    this.applyPlanPreset(slug, plan);
  }

  /**
   * Write the plan's preset entries into tenant_config. Existing keys
   * with the same name are overwritten — the contract is "switching
   * plans resets your caps to the plan default; you can re-customise
   * afterwards with `tenant set`".
   */
  private applyPlanPreset(slug: string, plan: Plan): void {
    for (const entry of planConfigEntries(plan)) {
      this.store.setConfig(slug, entry.key, entry.value);
    }
  }

  setConfig(slug: string, key: string, value: unknown): void {
    this.store.setConfig(slug, key, value);
  }

  /**
   * Store an API key for the tenant, encrypted with the master KEK.
   * Throws if no master vault is configured (Phase 6 dependency).
   */
  setApiKey(slug: string, keyName: string, value: string): void {
    if (!this.masterVault) {
      throw new ValidationError("master vault not configured — wire MasterKeyVault to use apikey commands");
    }
    const tenant = this.store.requireBySlug(slug);
    const { ciphertext, nonce } = this.masterVault.encrypt(tenant.id, keyName, value);
    this.store.putApiKey(slug, keyName, ciphertext, nonce);
  }

  listApiKeyNames(slug: string): string[] {
    return this.store.listApiKeyNames(slug);
  }

  deleteApiKey(slug: string, keyName: string): void {
    this.store.deleteApiKey(slug, keyName);
  }

  // ── lifecycle ────────────────────────────────────────────────────

  /**
   * Start a tenant. The runtime decides whether that's a local
   * subprocess or a cloud machine; this method only composes env and
   * delegates. Idempotent — re-calling for an already-running tenant
   * returns the existing handle.
   */
  async start(slug: string): Promise<{ id: string; port: number; upstreamUrl: string }> {
    const tenant = this.store.requireBySlug(slug);
    if (tenant.status === "suspended") throw new ValidationError(`tenant suspended: ${tenant.suspendReason ?? ""}`);
    if (tenant.status === "archived") throw new ValidationError(`tenant archived`);

    const existing = this.running.get(slug);
    if (existing && this.runtime.isRunning(slug)) {
      return { id: existing.runtimeId, port: existing.port, upstreamUrl: existing.upstreamUrl };
    }

    const env: Record<string, string> = {
      DAEMORA_TENANT_ID: tenant.id,
      DAEMORA_DATA_DIR: this.runtime.kind === "fly" ? "/data" : tenant.dataDir,
      PORT: String(tenant.port),
      DAEMON_MODE: "true",
      DAEMORA_FS_GUARD: "sandbox",
      DAEMORA_FS_ALLOW: this.runtime.kind === "fly" ? "/data" : tenant.dataDir,
      NODE_ENV: process.env["NODE_ENV"] ?? "production",
      DAEMORA_PLAN: tenant.plan,
    };

    const config = this.store.getAllConfig(slug);
    if (typeof config["profileId"] === "string") env["DAEMORA_PROFILE"] = config["profileId"];
    if (typeof config["maxDailyCost"] === "number") env["DAEMORA_MAX_DAILY_COST"] = String(config["maxDailyCost"]);
    if (typeof config["maxCostPerTask"] === "number") env["DAEMORA_MAX_COST_PER_TASK"] = String(config["maxCostPerTask"]);

    if (this.masterVault) {
      const rows = this.store.getAllApiKeys(slug);
      for (const row of rows) {
        env[row.keyName] = this.masterVault.decrypt(tenant.id, row.keyName, row.ciphertext, row.nonce);
      }
      const vp = rows.find((r) => r.keyName === "__vault_passphrase");
      if (vp) env["DAEMORA_VAULT_PASSPHRASE"] = this.masterVault.decrypt(tenant.id, "__vault_passphrase", vp.ciphertext, vp.nonce);
    }

    let started: StartedTenant;
    try {
      started = await this.runtime.start(tenant, env);
    } catch (err) {
      log.error({ slug, err: (err as Error).message }, "runtime start failed");
      this.store.setStatus(slug, "crashed");
      throw err;
    }

    this.running.set(slug, {
      slug,
      runtimeId: started.id,
      upstreamUrl: started.upstreamUrl,
      port: tenant.port,
      startedAt: Date.now(),
    });
    this.store.setStatus(slug, "running");
    return { id: started.id, port: tenant.port, upstreamUrl: started.upstreamUrl };
  }

  /** Stop a tenant. Idempotent. */
  async stop(slug: string): Promise<void> {
    await this.runtime.stop(slug).catch((err) => {
      log.warn({ slug, err: (err as Error).message }, "runtime stop failed");
    });
    this.running.delete(slug);
    const t = this.store.findBySlug(slug);
    if (t && t.status === "running") this.store.setStatus(slug, "sleeping");
  }

  async suspend(slug: string, reason: string): Promise<void> {
    await this.stop(slug);
    this.store.setStatus(slug, "suspended", reason);
    log.info({ slug, reason }, "tenant suspended");
  }

  async resume(slug: string): Promise<void> {
    const tenant = this.store.requireBySlug(slug);
    if (tenant.status !== "suspended") throw new ValidationError(`tenant is not suspended: ${tenant.status}`);
    this.store.setStatus(slug, "sleeping");
    log.info({ slug }, "tenant resumed (sleeping; call start to wake)");
  }

  async archive(slug: string): Promise<void> {
    await this.stop(slug);
    this.store.setStatus(slug, "archived");
    log.info({ slug }, "tenant archived");
    // Real archive (snapshot volume → R2) is a cloud-phase concern; in
    // local dev we just flip the status and leave the dir on disk.
  }

  /** Hard delete from registry. Tenant dir is left on disk (operator's call). */
  hardDelete(slug: string): void {
    this.store.hardDelete(slug);
  }

  /** Tell the control plane where to proxy a tenant's HTTP requests. */
  getUpstreamUrl(slug: string): string | undefined {
    return this.running.get(slug)?.upstreamUrl;
  }

  /** Shut down the runtime — local kills children, cloud leaves machines running. */
  async shutdown(): Promise<void> {
    log.info({ count: this.running.size, runtime: this.runtime.kind }, "TenantManager shutdown");
    await this.runtime.shutdown();
    this.running.clear();
  }

  /** Snapshot of currently-running tenants. */
  listRunning(): Array<{ slug: string; id: string; port: number; upstreamUrl: string; uptimeMs: number }> {
    return [...this.running.values()].map((r) => ({
      slug: r.slug,
      id: r.runtimeId,
      port: r.port,
      upstreamUrl: r.upstreamUrl,
      uptimeMs: Date.now() - r.startedAt,
    }));
  }
}

/** Resolve the path to dist/cli/index.js relative to this module. */
function resolveDaemoraEntry(): string {
  // From src/multitenant/TenantManager.ts → ../../dist/cli/index.js
  // (and same path resolves correctly when compiled to dist/multitenant/TenantManager.js)
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    // compiled layout
    join(here, "..", "..", "cli", "index.js"),
    // dev layout: src + dist sibling
    join(here, "..", "..", "..", "dist", "cli", "index.js"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`could not find daemora entry; checked: ${candidates.join(", ")}`);
}

