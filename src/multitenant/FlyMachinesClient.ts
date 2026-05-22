/**
 * Thin wrapper around Fly's Machines REST API.
 *
 * Docs: https://fly.io/docs/machines/api/
 *
 * We use this when the control plane runs in cloud mode — each tenant is
 * a Fly Machine inside a single "tenant-host" Fly app. That gives us:
 *   - one VM-level isolation boundary per user
 *   - per-tenant Fly Volume for persistence
 *   - auto-start / auto-stop / suspend hooks via the Machines API
 *
 * Auth: FLY_API_TOKEN bearer (org-level token, can create/destroy
 * machines under the target Fly app).
 */

import { setTimeout as wait } from "node:timers/promises";

const FLY_API_BASE = "https://api.machines.dev";

export interface FlyMachinesClientOpts {
  readonly apiToken: string;          // FLY_API_TOKEN
  readonly tenantAppName: string;     // Fly app that holds tenant machines, e.g. "daemora-tenants"
  readonly region: string;            // primary region, e.g. "iad"
  readonly tenantImage: string;       // OCI image ref, e.g. "registry.fly.io/daemora-tenants:latest"
  readonly fetch?: typeof fetch;
}

export interface MachineCreateInput {
  readonly slug: string;              // tenant slug, becomes machine name
  readonly env: Record<string, string>;
  readonly volumeId?: string;         // optional — attach existing per-tenant volume
  readonly cpus?: number;             // default 1
  readonly memoryMb?: number;         // default 512
}

export interface Machine {
  readonly id: string;
  readonly name: string;
  readonly state: string;             // "started" | "stopped" | "destroyed" | "created" | ...
  readonly region: string;
  readonly private_ip: string;        // 6PN address, reachable via .flycast
  readonly instance_id?: string;
}

export interface Volume {
  readonly id: string;
  readonly name: string;
  readonly region: string;
  readonly size_gb: number;
}

export class FlyMachinesError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message);
    this.name = "FlyMachinesError";
  }
}

export class FlyMachinesClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: FlyMachinesClientOpts) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  // ── machines ────────────────────────────────────────────────────

  /** Create + start a machine for a tenant. Idempotent on slug (returns existing if already there). */
  async createMachine(input: MachineCreateInput): Promise<Machine> {
    const existing = await this.findMachineBySlug(input.slug);
    if (existing) return existing;

    const body = {
      name: input.slug,
      region: this.opts.region,
      config: {
        image: this.opts.tenantImage,
        env: input.env,
        services: [
          {
            ports: [{ port: 80, handlers: ["http"] }, { port: 443, handlers: ["http", "tls"] }],
            internal_port: 8081,
            protocol: "tcp",
            // Auto-stop after 5 min idle, auto-start on next request.
            autostop: "stop",
            autostart: true,
            min_machines_running: 0,
          },
        ],
        guest: {
          cpu_kind: "shared",
          cpus: input.cpus ?? 1,
          memory_mb: input.memoryMb ?? 512,
        },
        ...(input.volumeId
          ? { mounts: [{ volume: input.volumeId, path: "/data" }] }
          : {}),
        checks: {
          health: {
            type: "http",
            port: 8081,
            method: "GET",
            path: "/health",
            interval: "30s",
            timeout: "5s",
            grace_period: "30s",
          },
        },
        restart: { policy: "on-failure", max_retries: 3 },
      },
    };

    return this.call<Machine>("POST", `/v1/apps/${this.opts.tenantAppName}/machines`, body);
  }

  async findMachineBySlug(slug: string): Promise<Machine | undefined> {
    const machines = await this.listMachines();
    return machines.find((m) => m.name === slug && m.state !== "destroyed");
  }

  async listMachines(): Promise<Machine[]> {
    return this.call<Machine[]>("GET", `/v1/apps/${this.opts.tenantAppName}/machines`);
  }

  async startMachine(machineId: string): Promise<void> {
    await this.call("POST", `/v1/apps/${this.opts.tenantAppName}/machines/${machineId}/start`);
  }

  async stopMachine(machineId: string): Promise<void> {
    await this.call("POST", `/v1/apps/${this.opts.tenantAppName}/machines/${machineId}/stop`);
  }

  async destroyMachine(machineId: string, force = false): Promise<void> {
    await this.call("DELETE", `/v1/apps/${this.opts.tenantAppName}/machines/${machineId}?force=${force}`);
  }

  /** Block until the machine reaches `targetState` (default "started"). */
  async waitForState(machineId: string, targetState = "started", timeoutMs = 60_000): Promise<Machine> {
    const deadline = Date.now() + timeoutMs;
    let last: Machine | undefined;
    while (Date.now() < deadline) {
      last = await this.call<Machine>("GET", `/v1/apps/${this.opts.tenantAppName}/machines/${machineId}`);
      if (last.state === targetState) return last;
      if (last.state === "destroyed") {
        throw new FlyMachinesError(410, `machine ${machineId} destroyed while waiting for ${targetState}`);
      }
      await wait(1000);
    }
    throw new FlyMachinesError(504, `timed out waiting for machine ${machineId} → ${targetState} (last: ${last?.state})`);
  }

  // ── volumes ─────────────────────────────────────────────────────

  /** One persistent volume per tenant. Returns existing if one already exists. */
  async ensureTenantVolume(slug: string, sizeGb = 3): Promise<Volume> {
    // Fly volume names: alphanumeric + underscore ONLY (no hyphens).
    // Tenant slugs include hyphens (e.g. user-at-gmail-com), so swap them.
    const name = `${slug.replace(/-/g, "_")}_data`;
    const volumes = await this.call<Volume[]>("GET", `/v1/apps/${this.opts.tenantAppName}/volumes`);
    const existing = volumes.find((v) => v.name === name);
    if (existing) return existing;

    return this.call<Volume>("POST", `/v1/apps/${this.opts.tenantAppName}/volumes`, {
      name,
      region: this.opts.region,
      size_gb: sizeGb,
    });
  }

  // ── internal ─────────────────────────────────────────────────────

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${FLY_API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.apiToken}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail: unknown = text;
      try { detail = JSON.parse(text); } catch { /* keep text */ }
      throw new FlyMachinesError(res.status, `Fly Machines ${method} ${path} failed: ${res.status}`, detail);
    }
    // DELETE returns 200 with no body in some cases.
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }
}

/**
 * Build the per-tenant flycast URL for HTTP proxying:
 *   http://<machine-name>.vm.<app>.internal:8081
 *
 * Reachable only from inside the same Fly org's 6PN network.
 */
export function tenantFlycastUrl(opts: { slug: string; tenantAppName: string; port?: number }): string {
  const port = opts.port ?? 8081;
  return `http://${opts.slug}.vm.${opts.tenantAppName}.internal:${port}`;
}
