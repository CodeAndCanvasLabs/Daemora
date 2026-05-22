/**
 * Thin HTTP client to the control plane's /admin/* API. apps/api
 * uses this to provision a tenant on signup, suspend on trial-expiry,
 * etc. Talks over the private network only — never exposed to users.
 */

export interface ControlPlaneClientOpts {
  readonly baseUrl: string;          // CONTROL_PLANE_INTERNAL_URL
  readonly adminToken: string;       // CONTROL_PLANE_ADMIN_TOKEN
  readonly fetch?: typeof fetch;     // overridable for tests
}

export interface ProvisionResult {
  readonly id: string;
  readonly slug: string;
  readonly port: number;
  readonly status: string;
  readonly dataDir: string;
}

export class ControlPlaneClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: ControlPlaneClientOpts) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** POST /admin/tenants — create + start tenant. */
  async provision(args: { email: string; plan: "trial" | "lite" | "pro"; slug?: string }): Promise<ProvisionResult> {
    return this.call<ProvisionResult>("POST", "/admin/tenants", args);
  }

  /** POST /admin/tenants/:slug/start */
  async start(slug: string): Promise<{ pid: number; port: number }> {
    return this.call("POST", `/admin/tenants/${encodeURIComponent(slug)}/start`);
  }

  /** POST /admin/tenants/:slug/stop */
  async stop(slug: string): Promise<{ ok: boolean }> {
    return this.call("POST", `/admin/tenants/${encodeURIComponent(slug)}/stop`);
  }

  /** POST /admin/tenants/:slug/suspend  { reason } */
  async suspend(slug: string, reason: string): Promise<{ ok: boolean }> {
    return this.call("POST", `/admin/tenants/${encodeURIComponent(slug)}/suspend`, { reason });
  }

  /** GET /admin/tenants/:slug */
  async show(slug: string): Promise<unknown> {
    return this.call("GET", `/admin/tenants/${encodeURIComponent(slug)}`);
  }

  /** GET /admin/tenants */
  async list(): Promise<{ tenants: unknown[] }> {
    return this.call("GET", "/admin/tenants");
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.adminToken}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`control-plane ${method} ${path} failed: ${res.status} ${txt}`);
    }
    return res.json() as Promise<T>;
  }
}
