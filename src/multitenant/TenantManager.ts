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
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type postgres from "postgres";

import { createLogger } from "../util/logger.js";
import { ValidationError } from "../util/errors.js";
import type { MasterKeyVault } from "./MasterKeyVault.js";
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
import { PgTenantRegistry } from "./PgTenantRegistry.js";

const log = createLogger("multitenant.manager");

/** Quick liveness probe used to adopt orphaned tenant children after a gateway restart. */
async function probeHealth(baseUrl: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${baseUrl}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

interface RunningTenant {
  readonly slug: string;
  readonly upstreamUrl: string;       // local: http://127.0.0.1:<port>, fly: flycast URL
  readonly runtimeId: string;         // pid (local) or machine id (cloud)
  readonly port: number;
  readonly startedAt: number;
}

export interface TenantManagerOpts {
  readonly dataRoot: string;          // <root>/data
  /** Postgres client backing the tenant registry (#25 — replaces SQLite tenants.db). */
  readonly sql: postgres.Sql;
  readonly daemoraEntry?: string;     // path to dist/cli/index.js (auto-detected if absent)
  readonly masterVault?: MasterKeyVault;
  /** Override runtime — defaults to LocalChildProcessRuntime for back-compat. */
  readonly runtime?: TenantRuntime;
  /**
   * Central (Postgres) config source. When set, the tenant is given its config
   * at boot via DAEMORA_BOOT_CONFIG so Postgres — not machine SQLite — is the
   * source of truth (fixes settings reverting on machine recreation/restart).
   */
  readonly bootConfigProvider?: (slug: string) => Promise<Record<string, unknown>>;
}

export class TenantManager {
  private readonly store: PgTenantRegistry;
  private readonly dataRoot: string;
  private readonly runtime: TenantRuntime;
  private readonly running = new Map<string, RunningTenant>();
  private readonly masterVault?: MasterKeyVault;
  private readonly bootConfigProvider?: (slug: string) => Promise<Record<string, unknown>>;

  constructor(opts: TenantManagerOpts) {
    this.dataRoot = opts.dataRoot;
    this.store = new PgTenantRegistry(opts.sql);
    this.runtime = opts.runtime ?? new LocalChildProcessRuntime({
      daemoraEntry: opts.daemoraEntry ?? resolveDaemoraEntry(),
    });
    if (opts.masterVault) this.masterVault = opts.masterVault;
    if (opts.bootConfigProvider) this.bootConfigProvider = opts.bootConfigProvider;
  }

  /** Hydrate the registry cache from Postgres. Call once before serving. */
  async init(): Promise<void> {
    await this.store.hydrate();
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  /** Underlying registry for read paths that don't need orchestration. */
  get registry(): PgTenantRegistry {
    return this.store;
  }

  // ── create / read ────────────────────────────────────────────────

  async create(input: CreateTenantInput): Promise<Tenant> {
    const tenant = await this.store.create(input, this.dataRoot);
    mkdirSync(tenant.dataDir, { recursive: true });
    // Skeleton subdirs the agent's own boot expects to find.
    for (const sub of ["wiki", "projects", "outputs", "custom-skills", "browser", "memory"]) {
      mkdirSync(join(tenant.dataDir, sub), { recursive: true });
    }
    // Plan caps are derived from `plan` (getAllConfig computes planConfigEntries),
    // so there's nothing to seed here — switching plans changes the caps for free.
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

  async setPlan(slug: string, plan: Plan): Promise<void> {
    // Caps are derived from `plan` at read time (getAllConfig), so changing the
    // plan is enough — no preset rows to rewrite.
    await this.store.setPlan(slug, plan);
  }

  async setConfig(slug: string, key: string, value: unknown): Promise<void> {
    await this.store.setConfig(slug, key, value);
  }

  /**
   * Store an API key for the tenant, encrypted with the master KEK.
   * Throws if no master vault is configured (Phase 6 dependency).
   */
  async setApiKey(slug: string, keyName: string, value: string): Promise<void> {
    if (!this.masterVault) {
      throw new ValidationError("master vault not configured — wire MasterKeyVault to use apikey commands");
    }
    const tenant = this.store.requireBySlug(slug);
    const { ciphertext, nonce } = this.masterVault.encrypt(tenant.id, keyName, value);
    await this.store.putApiKey(slug, keyName, ciphertext, nonce);
  }

  listApiKeyNames(slug: string): string[] {
    return this.store.listApiKeyNames(slug);
  }

  async deleteApiKey(slug: string, keyName: string): Promise<void> {
    await this.store.deleteApiKey(slug, keyName);
  }

  /**
   * Decrypt all of a tenant's stored secrets into an env-style map. The
   * `__vault_passphrase` entry is additionally surfaced as
   * `DAEMORA_VAULT_PASSPHRASE`. Empty when no master vault is configured.
   *
   * Used by (1) the legacy boot env injection and (2) the gateway secret
   * broker, which delivers these to the tenant IN-MEMORY at boot so they
   * never have to live in the machine env (threat T6). NEVER log the values.
   */
  getDecryptedSecrets(slug: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!this.masterVault) return out;
    const tenant = this.store.requireBySlug(slug);
    for (const row of this.store.getAllApiKeys(slug)) {
      out[row.keyName] = this.masterVault.decrypt(tenant.id, row.keyName, row.ciphertext, row.nonce);
    }
    const vp = out["__vault_passphrase"];
    if (vp) out["DAEMORA_VAULT_PASSPHRASE"] = vp;
    return out;
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

    // Adopt an orphan from a previous gateway process. After a gateway restart
    // our in-memory `running` map is empty, but the registry may still say
    // "running" and the tenant child may still be alive on its port. Spawning
    // again would EADDRINUSE on the same port (and waitForHealth would falsely
    // pass by hitting the orphan). So if the port answers /health, adopt it
    // in-memory instead of respawning. If it's dead, clear the stale status and
    // fall through to a fresh spawn.
    if (!existing && this.runtime.kind === "local" && tenant.status === "running") {
      const url = `http://127.0.0.1:${tenant.port}`;
      if (await probeHealth(url)) {
        const adopted: RunningTenant = {
          slug,
          runtimeId: `adopted:${tenant.port}`,
          upstreamUrl: url,
          port: tenant.port,
          startedAt: Date.now(),
        };
        this.running.set(slug, adopted);
        log.info({ slug, port: tenant.port }, "adopted orphaned tenant child");
        return { id: adopted.runtimeId, port: adopted.port, upstreamUrl: adopted.upstreamUrl };
      }
      log.warn({ slug, port: tenant.port }, "registry says running but port is dead — respawning");
    }

    const env: Record<string, string> = {
      DAEMORA_TENANT_ID: tenant.id,
      // ABSOLUTE paths — the tenant chdir's to its data dir and the FS sandbox
      // allow-root must be unambiguous (relative paths would resolve against the
      // gateway cwd and let the agent escape to the repo / sibling tenants).
      DAEMORA_DATA_DIR: this.runtime.kind === "fly" ? "/data" : resolve(tenant.dataDir),
      PORT: String(tenant.port),
      DAEMON_MODE: "true",
      DAEMORA_FS_GUARD: "sandbox",
      DAEMORA_FS_ALLOW: this.runtime.kind === "fly" ? "/data" : resolve(tenant.dataDir),
      NODE_ENV: process.env["NODE_ENV"] ?? "production",
      DAEMORA_PLAN: tenant.plan,
    };

    const config = this.store.getAllConfig(slug);
    if (typeof config["profileId"] === "string") env["DAEMORA_PROFILE"] = config["profileId"];
    if (typeof config["maxDailyCost"] === "number") env["DAEMORA_MAX_DAILY_COST"] = String(config["maxDailyCost"]);
    if (typeof config["maxCostPerTask"] === "number") env["DAEMORA_MAX_COST_PER_TASK"] = String(config["maxCostPerTask"]);

    // SECURITY (T6): decrypted secrets are still injected as env for now —
    // readable via /proc / crash dumps. The gateway secret broker delivers
    // these IN-MEMORY at boot instead; once the owner validates that path
    // locally, REMOVE this block so secrets never touch the machine env.
    // (getDecryptedSecrets is the single source the broker also uses.)
    if (this.masterVault) {
      Object.assign(env, this.getDecryptedSecrets(slug));
    }

    // Central config delivery: Postgres is the source of truth. Hand the tenant
    // its config at boot so machine SQLite is just a re-seeded cache — settings
    // never silently revert on restart/recreation. Fail soft (never block boot).
    if (this.bootConfigProvider) {
      try {
        const cfg = await this.bootConfigProvider(slug);
        if (cfg && Object.keys(cfg).length > 0) env["DAEMORA_BOOT_CONFIG"] = JSON.stringify(cfg);
      } catch (err) {
        log.warn({ slug, err: (err as Error).message }, "boot config fetch failed — tenant uses local cache");
      }
    }

    let started: StartedTenant;
    try {
      started = await this.runtime.start(tenant, env);
    } catch (err) {
      log.error({ slug, err: (err as Error).message }, "runtime start failed");
      await this.store.setStatus(slug, "crashed");
      throw err;
    }

    this.running.set(slug, {
      slug,
      runtimeId: started.id,
      upstreamUrl: started.upstreamUrl,
      port: tenant.port,
      startedAt: Date.now(),
    });
    await this.store.setStatus(slug, "running");
    return { id: started.id, port: tenant.port, upstreamUrl: started.upstreamUrl };
  }

  /** Stop a tenant. Idempotent. */
  async stop(slug: string): Promise<void> {
    await this.runtime.stop(slug).catch((err) => {
      log.warn({ slug, err: (err as Error).message }, "runtime stop failed");
    });
    this.running.delete(slug);
    const t = this.store.findBySlug(slug);
    if (t && t.status === "running") await this.store.setStatus(slug, "sleeping");
  }

  async suspend(slug: string, reason: string): Promise<void> {
    await this.stop(slug);
    await this.store.setStatus(slug, "suspended", reason);
    log.info({ slug, reason }, "tenant suspended");
  }

  async resume(slug: string): Promise<void> {
    const tenant = this.store.requireBySlug(slug);
    if (tenant.status !== "suspended") throw new ValidationError(`tenant is not suspended: ${tenant.status}`);
    await this.store.setStatus(slug, "sleeping");
    log.info({ slug }, "tenant resumed (sleeping; call start to wake)");
  }

  async archive(slug: string): Promise<void> {
    await this.stop(slug);
    await this.store.setStatus(slug, "archived");
    log.info({ slug }, "tenant archived");
    // Real archive (snapshot volume → R2) is a cloud-phase concern; in
    // local dev we just flip the status and leave the dir on disk.
  }

  /** Hard delete from registry. Tenant dir is left on disk (operator's call). */
  async hardDelete(slug: string): Promise<void> {
    await this.store.hardDelete(slug);
  }

  /** Tell the control plane where to proxy a tenant's HTTP requests. */
  getUpstreamUrl(slug: string): string | undefined {
    const r = this.running.get(slug);
    if (!r) return undefined;
    // Evict stale entries whose runtime child has exited. Adopted orphans
    // (runtimeId "adopted:*") aren't tracked by the runtime's process map, so
    // don't evict those here — they're verified by health probe at adoption.
    if (!r.runtimeId.startsWith("adopted:") && !this.runtime.isRunning(slug)) {
      this.running.delete(slug);
      return undefined;
    }
    return r.upstreamUrl;
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

