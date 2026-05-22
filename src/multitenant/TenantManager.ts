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

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger } from "../util/logger.js";
import { ValidationError } from "../util/errors.js";
import type { MasterKeyVault } from "./MasterKeyVault.js";
import { planConfigEntries } from "./plans.js";
import {
  type CreateTenantInput,
  type Plan,
  type Tenant,
  type TenantDetail,
  type TenantStatus,
} from "./types.js";
import { TenantStore } from "./TenantStore.js";

const log = createLogger("multitenant.manager");

const HEALTH_POLL_INTERVAL_MS = 200;
const HEALTH_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

interface RunningTenant {
  readonly slug: string;
  readonly proc: ChildProcess;
  readonly startedAt: number;
  readonly port: number;
}

export interface TenantManagerOpts {
  readonly dataRoot: string;          // <root>/data
  readonly daemoraEntry?: string;     // path to dist/cli/index.js (auto-detected if absent)
  readonly masterVault?: MasterKeyVault;
}

export class TenantManager {
  private readonly store: TenantStore;
  private readonly dataRoot: string;
  private readonly daemoraEntry: string;
  private readonly running = new Map<string, RunningTenant>();
  private readonly masterVault?: MasterKeyVault;

  constructor(opts: TenantManagerOpts) {
    this.dataRoot = opts.dataRoot;
    this.store = new TenantStore(join(opts.dataRoot, "tenants.db"));
    this.daemoraEntry = opts.daemoraEntry ?? resolveDaemoraEntry();
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
      ...(r ? { runtime: { pid: r.proc.pid ?? -1, uptimeMs: Date.now() - r.startedAt } } : {}),
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
   * Start a tenant's daemora subprocess. If already running, no-op.
   * Resolves once the tenant's /health returns 200 — up to 30s.
   */
  async start(slug: string): Promise<{ pid: number; port: number }> {
    const tenant = this.store.requireBySlug(slug);
    if (tenant.status === "suspended") throw new ValidationError(`tenant suspended: ${tenant.suspendReason ?? ""}`);
    if (tenant.status === "archived") throw new ValidationError(`tenant archived`);

    const existing = this.running.get(slug);
    if (existing && existing.proc.exitCode === null) {
      return { pid: existing.proc.pid ?? -1, port: existing.port };
    }

    // Compose env: per-tenant identity, isolation, secrets.
    const env: NodeJS.ProcessEnv = {
      ...process.env,                       // node, PATH — keep
      DAEMORA_TENANT_ID: tenant.id,
      DAEMORA_DATA_DIR: tenant.dataDir,
      PORT: String(tenant.port),
      DAEMON_MODE: "true",
      DAEMORA_FS_GUARD: "sandbox",
      DAEMORA_FS_ALLOW: tenant.dataDir,
      NODE_ENV: process.env["NODE_ENV"] ?? "production",
    };

    // Plan-derived config (Phase 5 will read from PLANS preset; here we
    // just pass what's stored).
    const plan = tenant.plan;
    env["DAEMORA_PLAN"] = plan;
    const config = this.store.getAllConfig(slug);
    if (typeof config["profileId"] === "string") env["DAEMORA_PROFILE"] = config["profileId"];
    if (typeof config["maxDailyCost"] === "number") env["DAEMORA_MAX_DAILY_COST"] = String(config["maxDailyCost"]);
    if (typeof config["maxCostPerTask"] === "number") env["DAEMORA_MAX_COST_PER_TASK"] = String(config["maxCostPerTask"]);

    // Decrypted per-tenant secrets — never persisted to disk.
    if (this.masterVault) {
      const rows = this.store.getAllApiKeys(slug);
      for (const row of rows) {
        const value = this.masterVault.decrypt(tenant.id, row.keyName, row.ciphertext, row.nonce);
        env[row.keyName] = value;
      }
      // The tenant's daemora vault passphrase is a special key. If
      // it's present, expose it under DAEMORA_VAULT_PASSPHRASE so the
      // child unlocks its own vault automatically.
      const vp = rows.find((r) => r.keyName === "__vault_passphrase");
      if (vp) {
        env["DAEMORA_VAULT_PASSPHRASE"] = this.masterVault.decrypt(tenant.id, "__vault_passphrase", vp.ciphertext, vp.nonce);
      }
    }

    log.info({ slug, dataDir: tenant.dataDir, port: tenant.port, entry: this.daemoraEntry }, "spawning tenant");
    const proc = spawn(process.execPath, [this.daemoraEntry, "start"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Keep child in our group so signalTree finds it on shutdown.
      detached: false,
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      const s = chunk.toString().trim();
      if (s) log.info({ slug, kind: "stdout" }, s);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString().trim();
      if (s) log.warn({ slug, kind: "stderr" }, s);
    });
    proc.on("exit", (code, signal) => {
      log.info({ slug, code, signal }, "tenant exited");
      this.running.delete(slug);
      // Only flip status if we weren't the one stopping it.
      const current = this.store.findBySlug(slug);
      if (current && current.status === "running") {
        this.store.setStatus(slug, code === 0 ? "sleeping" : "crashed");
      }
    });

    this.running.set(slug, { slug, proc, startedAt: Date.now(), port: tenant.port });
    this.store.setStatus(slug, "running");

    // Wait for /health.
    await waitForHealth(tenant.port, HEALTH_TIMEOUT_MS).catch((err) => {
      log.error({ slug, err: err.message }, "tenant failed health check — killing");
      this.stop(slug).catch(() => {});
      throw new Error(`tenant ${slug} did not become healthy: ${err.message}`);
    });

    return { pid: proc.pid ?? -1, port: tenant.port };
  }

  /**
   * Stop a tenant. SIGTERM, then SIGKILL after STOP_TIMEOUT_MS.
   * Idempotent — no error if not running.
   */
  async stop(slug: string): Promise<void> {
    const running = this.running.get(slug);
    if (!running) {
      // Update status anyway in case it was lingering.
      const t = this.store.findBySlug(slug);
      if (t && t.status === "running") this.store.setStatus(slug, "sleeping");
      return;
    }
    const proc = running.proc;
    if (proc.exitCode !== null) {
      this.running.delete(slug);
      return;
    }

    log.info({ slug, pid: proc.pid }, "stopping tenant (SIGTERM)");
    proc.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (proc.exitCode === null) {
          log.warn({ slug, pid: proc.pid }, "tenant ignored SIGTERM — SIGKILL");
          proc.kill("SIGKILL");
        }
        resolve();
      }, STOP_TIMEOUT_MS);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
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

  /** SIGTERM every running tenant, wait, then return. For control-plane shutdown. */
  async shutdown(): Promise<void> {
    const slugs = [...this.running.keys()];
    log.info({ count: slugs.length }, "TenantManager shutdown — stopping all tenants");
    await Promise.all(slugs.map((s) => this.stop(s).catch((e) => log.warn({ slug: s, err: (e as Error).message }, "stop failed"))));
  }

  /** Snapshot of currently-running tenants. */
  listRunning(): Array<{ slug: string; pid: number; port: number; uptimeMs: number }> {
    const out: Array<{ slug: string; pid: number; port: number; uptimeMs: number }> = [];
    for (const r of this.running.values()) {
      out.push({ slug: r.slug, pid: r.proc.pid ?? -1, port: r.port, uptimeMs: Date.now() - r.startedAt });
    }
    return out;
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

/** Poll http://localhost:<port>/health until 200 or timeout. */
async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return;
      lastErr = `status ${res.status}`;
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  throw new Error(`timed out after ${timeoutMs}ms — last: ${String(lastErr)}`);
}
