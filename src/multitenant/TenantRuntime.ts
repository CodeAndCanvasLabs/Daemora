/**
 * TenantRuntime — the "how do I actually run a tenant?" abstraction.
 *
 * Two implementations:
 *   - LocalChildProcessRuntime: dev/single-host. spawn() a daemora child.
 *   - FlyMachinesRuntime: cloud. creates + starts a Fly Machine per tenant.
 *
 * TenantManager picks one at construction. The rest of the system
 * (control plane, /admin/* routes, etc.) doesn't care which is in use.
 */

import { spawn, type ChildProcess } from "node:child_process";

import { createLogger } from "../util/logger.js";
import {
  FlyMachinesClient,
  tenantFlycastUrl,
  type Machine,
} from "./FlyMachinesClient.js";
import type { Tenant } from "./types.js";

const log = createLogger("multitenant.runtime");

export interface StartedTenant {
  /** Where to proxy HTTP requests for this tenant. */
  readonly upstreamUrl: string;
  /** Implementation-specific id. PID for local, Fly machine id for cloud. */
  readonly id: string;
}

export interface TenantRuntime {
  readonly kind: "local" | "fly";
  start(tenant: Tenant, env: Record<string, string>): Promise<StartedTenant>;
  stop(slug: string): Promise<void>;
  isRunning(slug: string): boolean;
  shutdown(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────
// LOCAL — child_process. Existing behaviour, extracted for clarity.
// ─────────────────────────────────────────────────────────────────────

interface LocalRecord {
  readonly slug: string;
  readonly proc: ChildProcess;
  readonly port: number;
  readonly startedAt: number;
}

export interface LocalChildProcessOpts {
  readonly daemoraEntry: string;          // path to dist/cli/index.js
  readonly healthTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
}

export class LocalChildProcessRuntime implements TenantRuntime {
  readonly kind = "local" as const;
  private readonly running = new Map<string, LocalRecord>();

  constructor(private readonly opts: LocalChildProcessOpts) {}

  async start(tenant: Tenant, env: Record<string, string>): Promise<StartedTenant> {
    const existing = this.running.get(tenant.slug);
    if (existing && existing.proc.exitCode === null) {
      return { upstreamUrl: `http://127.0.0.1:${existing.port}`, id: String(existing.proc.pid ?? -1) };
    }

    log.info({ slug: tenant.slug, port: tenant.port, entry: this.opts.daemoraEntry }, "spawning tenant (local)");
    // SECURITY: the tenant process must NOT inherit the gateway's crown-jewel
    // secrets. MASTER_KEK decrypts EVERY tenant's keys and DATABASE_URL is the
    // whole control-plane DB — the tenant's `start` path uses neither (verified).
    // Strip them (+ other gateway-only secrets) so a tenant-side bug or escape
    // can never reach them. The tenant keeps what it needs (Vertex creds,
    // INTERNAL_SIGNING_SECRET, its own injected keys via `env`). Cloud already
    // passes a curated env (see FlyMachinesRuntime).
    const STRIP = new Set([
      "MASTER_KEK", "DATABASE_URL", "SESSION_COOKIE_SECRET", "RESEND_API_KEY",
      "CONTRA_PAYMENT_LINK_LITE", "CONTRA_PAYMENT_LINK_PRO", "CONTRA_API_KEY",
    ]);
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP.has(k)) base[k] = v;
    const proc = spawn(process.execPath, [this.opts.daemoraEntry, "start"], {
      env: { ...base, ...env, PORT: String(tenant.port) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      const s = chunk.toString().trim();
      if (s) log.info({ slug: tenant.slug, kind: "stdout" }, s);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString().trim();
      if (s) log.warn({ slug: tenant.slug, kind: "stderr" }, s);
    });
    proc.on("exit", (code, signal) => {
      log.info({ slug: tenant.slug, code, signal }, "tenant exited");
      this.running.delete(tenant.slug);
    });

    this.running.set(tenant.slug, { slug: tenant.slug, proc, port: tenant.port, startedAt: Date.now() });

    await waitForHealth(`http://127.0.0.1:${tenant.port}/health`, this.opts.healthTimeoutMs ?? 30_000);

    return { upstreamUrl: `http://127.0.0.1:${tenant.port}`, id: String(proc.pid ?? -1) };
  }

  async stop(slug: string): Promise<void> {
    const r = this.running.get(slug);
    if (!r) return;
    if (r.proc.exitCode !== null) {
      this.running.delete(slug);
      return;
    }
    log.info({ slug, pid: r.proc.pid }, "stopping tenant (SIGTERM)");
    r.proc.kill("SIGTERM");
    const timeoutMs = this.opts.stopTimeoutMs ?? 5_000;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (r.proc.exitCode === null) {
          log.warn({ slug, pid: r.proc.pid }, "tenant ignored SIGTERM — SIGKILL");
          r.proc.kill("SIGKILL");
        }
        resolve();
      }, timeoutMs);
      r.proc.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    this.running.delete(slug);
  }

  isRunning(slug: string): boolean {
    const r = this.running.get(slug);
    return !!r && r.proc.exitCode === null;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.running.keys()].map((s) => this.stop(s).catch(() => {})));
  }

  /** Snapshot — used by TenantManager for /admin/runtime listings. */
  list(): Array<{ slug: string; pid: number; port: number; uptimeMs: number }> {
    return [...this.running.values()].map((r) => ({
      slug: r.slug,
      pid: r.proc.pid ?? -1,
      port: r.port,
      uptimeMs: Date.now() - r.startedAt,
    }));
  }
}

// ─────────────────────────────────────────────────────────────────────
// CLOUD — Fly Machines API.
// ─────────────────────────────────────────────────────────────────────

interface FlyRecord {
  readonly slug: string;
  readonly machineId: string;
  readonly upstreamUrl: string;
  readonly startedAt: number;
}

export interface FlyMachinesOpts {
  readonly client: FlyMachinesClient;
  readonly tenantAppName: string;
  readonly waitTimeoutMs?: number;
}

export class FlyMachinesRuntime implements TenantRuntime {
  readonly kind = "fly" as const;
  private readonly running = new Map<string, FlyRecord>();

  constructor(private readonly opts: FlyMachinesOpts) {}

  async start(tenant: Tenant, env: Record<string, string>): Promise<StartedTenant> {
    const existing = this.running.get(tenant.slug);
    if (existing) return { upstreamUrl: existing.upstreamUrl, id: existing.machineId };

    log.info({ slug: tenant.slug }, "ensuring volume + creating machine (Fly)");
    const volume = await this.opts.client.ensureTenantVolume(tenant.slug);

    // Fly's create endpoint requires env values as strings; coerce.
    const stringEnv: Record<string, string> = {};
    for (const k of Object.keys(env)) stringEnv[k] = String(env[k]);

    const machine = await this.opts.client.createMachine({
      slug: tenant.slug,
      env: stringEnv,
      volumeId: volume.id,
    });

    // If machine was found existing in non-started state, kick it.
    let m: Machine = machine;
    if (m.state !== "started") {
      try { await this.opts.client.startMachine(m.id); } catch { /* may already be starting */ }
      m = await this.opts.client.waitForState(m.id, "started", this.opts.waitTimeoutMs ?? 60_000);
    }

    const upstreamUrl = tenantFlycastUrl({ slug: tenant.slug, tenantAppName: this.opts.tenantAppName });
    this.running.set(tenant.slug, { slug: tenant.slug, machineId: m.id, upstreamUrl, startedAt: Date.now() });
    return { upstreamUrl, id: m.id };
  }

  async stop(slug: string): Promise<void> {
    const r = this.running.get(slug);
    if (!r) return;
    log.info({ slug, machineId: r.machineId }, "stopping machine (Fly)");
    try { await this.opts.client.stopMachine(r.machineId); }
    catch (err) { log.warn({ slug, err: (err as Error).message }, "stop failed"); }
    this.running.delete(slug);
  }

  isRunning(slug: string): boolean {
    return this.running.has(slug);
  }

  async shutdown(): Promise<void> {
    // Cloud machines persist across control-plane restarts (by design —
    // user data lives on volumes). We don't stop them on shutdown.
    this.running.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      last = `status ${res.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`health check timed out after ${timeoutMs}ms — last: ${String(last)}`);
}
