/**
 * Phase 4: Control plane smoke tests.
 *
 *  - tenant resolution (subdomain in prod; header / query / cookie in dev)
 *  - admin API auth (bearer required + constant-time compare)
 *  - admin CRUD endpoints
 *  - reverse proxy forwards HTTP requests to the right port
 *  - suspended tenant returns 402; archived returns 410
 *  - unknown tenant returns 404
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";

import { MasterKeyVault } from "../src/multitenant/MasterKeyVault.js";
import { TenantManager } from "../src/multitenant/TenantManager.js";
import { resolveTenant, startControlPlane, type ControlPlane } from "../src/multitenant/controlPlane.js";

// ── helpers ───────────────────────────────────────────────────────

interface FakeReq {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

function makeReq(headers: Record<string, string> = {}, url = "/"): FakeReq {
  return { url, method: "GET", headers };
}

async function freePort(): Promise<number> {
  // Bind to :0 to get a free port assigned by the kernel, then close.
  return new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        s.close(() => resolve(p));
      } else {
        s.close(() => reject(new Error("no address")));
      }
    });
  });
}

function startUpstream(port: number, handler: (path: string, method: string) => { status: number; body: string }): Server {
  const s = createServer((req, res) => {
    const r = handler(req.url ?? "/", req.method ?? "GET");
    res.statusCode = r.status;
    res.setHeader("content-type", "text/plain");
    res.end(r.body);
  });
  s.listen(port);
  return s;
}

// ── resolveTenant unit tests (no server) ──────────────────────────

describe("resolveTenant", () => {
  it("resolves from X-Tenant-Slug header", () => {
    expect(resolveTenant(makeReq({ "x-tenant-slug": "alice" }) as never, ".daemora.app")).toBe("alice");
  });

  it("resolves from subdomain when hostSuffix matches", () => {
    expect(
      resolveTenant(makeReq({ host: "alice.daemora.app:8080" }) as never, ".daemora.app"),
    ).toBe("alice");
  });

  it("ignores subdomain when hostSuffix doesn't match", () => {
    expect(
      resolveTenant(makeReq({ host: "alice.example.com" }) as never, ".daemora.app"),
    ).toBeUndefined();
  });

  it("does NOT honor a forgeable JWT tenant claim (security: path removed)", () => {
    const claims = { sub: "user-123", tenant: "alice", exp: 9999999999 };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const token = `header.${payload}.signature`;
    expect(
      resolveTenant(makeReq({ authorization: `Bearer ${token}` }) as never, ".daemora.app"),
    ).toBeUndefined();
  });

  it("SECURITY: in production, ignores unauthenticated hints (header/query/cookie) and only honors subdomain", () => {
    const prev = process.env["NODE_ENV"];
    const prevDev = process.env["DAEMORA_DEV_ROUTING"];
    process.env["NODE_ENV"] = "production";
    delete process.env["DAEMORA_DEV_ROUTING"];
    try {
      // Forgeable hints are refused.
      expect(resolveTenant(makeReq({ "x-tenant-slug": "victim" }) as never, ".daemora.app")).toBeUndefined();
      expect(resolveTenant(makeReq({}, "/?slug=victim") as never, ".daemora.app")).toBeUndefined();
      expect(resolveTenant(makeReq({ cookie: "daemora-tenant=victim" }) as never, ".daemora.app")).toBeUndefined();
      // Subdomain still routes.
      expect(resolveTenant(makeReq({ host: "alice.daemora.app" }) as never, ".daemora.app")).toBe("alice");
    } finally {
      if (prev === undefined) delete process.env["NODE_ENV"]; else process.env["NODE_ENV"] = prev;
      if (prevDev !== undefined) process.env["DAEMORA_DEV_ROUTING"] = prevDev;
    }
  });

  it("rejects invalid slug (non-DNS-safe)", () => {
    expect(
      resolveTenant(makeReq({ "x-tenant-slug": "alice@bad" }) as never, ".daemora.app"),
    ).toBeUndefined();
  });

  it("header beats subdomain (priority)", () => {
    expect(
      resolveTenant(
        makeReq({ "x-tenant-slug": "alice", host: "bob.daemora.app" }) as never,
        ".daemora.app",
      ),
    ).toBe("alice");
  });

  it("resolves from ?slug= query (dev kickoff)", () => {
    expect(
      resolveTenant(makeReq({}, "/?slug=alice") as never, ".daemora.app"),
    ).toBe("alice");
  });

  it("resolves from daemora-tenant cookie (dev follow-up)", () => {
    expect(
      resolveTenant(makeReq({ cookie: "daemora-tenant=alice" }) as never, ".daemora.app"),
    ).toBe("alice");
  });

  it("?slug= beats cookie when both present", () => {
    expect(
      resolveTenant(
        makeReq({ cookie: "daemora-tenant=stale" }, "/?slug=fresh") as never,
        ".daemora.app",
      ),
    ).toBe("fresh");
  });
});

// ── control plane integration tests ───────────────────────────────

// Integration smoke — registry is in Postgres (#25). Needs DATABASE_URL pointed
// at a TEST database; skipped in the default unit run.
const CP_DB_URL = process.env["DATABASE_URL"];
const cpSql = CP_DB_URL ? postgres(CP_DB_URL, { prepare: false, max: 3 }) : (undefined as unknown as ReturnType<typeof postgres>);

describe.skipIf(!CP_DB_URL)("control plane HTTP server", () => {
  let manager: TenantManager;
  let cp: ControlPlane;
  let cpPort: number;
  let dataRoot: string;
  let adminToken: string;
  const upstreams: Server[] = [];

  beforeEach(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "daemora-cp-"));
    const vault = new MasterKeyVault(randomBytes(32));
    manager = new TenantManager({ dataRoot, sql: cpSql, masterVault: vault });
    await manager.init();
    adminToken = "test-admin-token-" + randomBytes(8).toString("hex");
    cpPort = await freePort();
    cp = startControlPlane({
      port: cpPort,
      manager,
      hostSuffix: ".test.local",
      adminToken,
    });
    // Tiny wait for listen() to flush.
    await new Promise((r) => setTimeout(r, 50));
  });

  afterEach(async () => {
    for (const u of upstreams) await new Promise((r) => u.close(() => r(null)));
    upstreams.length = 0;
    await cp.close();
    // Clean up only the tenants this suite creates (all @x.com) so re-runs are
    // idempotent and we never touch real tenants.
    for (const t of manager.list().filter((x) => x.email.endsWith("@x.com"))) {
      await manager.stop(t.slug).catch(() => {});
      await manager.hardDelete(t.slug).catch(() => {});
    }
    await manager.close();
  });

  afterAll(async () => { await cpSql.end({ timeout: 5 }).catch(() => {}); });

  it("GET /health returns ok", async () => {
    const res = await fetch(`http://127.0.0.1:${cpPort}/health`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true });
  });

  it("rejects /admin/* without bearer", async () => {
    const res = await fetch(`http://127.0.0.1:${cpPort}/admin/tenants`);
    expect(res.status).toBe(401);
  });

  it("rejects /admin/* with wrong bearer", async () => {
    const res = await fetch(`http://127.0.0.1:${cpPort}/admin/tenants`, {
      headers: { authorization: `Bearer wrong-token` },
    });
    expect(res.status).toBe(401);
  });

  it("admin can list tenants", async () => {
    const res = await fetch(`http://127.0.0.1:${cpPort}/admin/tenants`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body).toEqual({ tenants: [] });
  });

  it("admin can create a tenant via POST /admin/tenants", async () => {
    const res = await fetch(`http://127.0.0.1:${cpPort}/admin/tenants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "alice@daemora.com", plan: "trial" }),
    });
    expect(res.status).toBe(201);
    const tenant = (await res.json()) as { slug: string; email: string };
    expect(tenant.email).toBe("alice@daemora.com");
    expect(tenant.slug).toContain("alice");
  });

  it("returns 400 when tenant cannot be resolved", async () => {
    const res = await fetch(`http://127.0.0.1:${cpPort}/anything`);
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown tenant slug in header", async () => {
    const res = await fetch(`http://127.0.0.1:${cpPort}/anything`, {
      headers: { "x-tenant-slug": "nonexistent" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 402 when tenant is suspended (subscription_required)", async () => {
    const t = await manager.create({ email: "sus@x.com", plan: "trial" });
    manager.registry.setStatus(t.slug, "suspended", "trial expired");
    const res = await fetch(`http://127.0.0.1:${cpPort}/anything`, {
      headers: { "x-tenant-slug": t.slug },
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("subscription_required");
  });

  it("returns 410 when tenant is archived", async () => {
    const t = await manager.create({ email: "arc@x.com", plan: "trial" });
    manager.registry.setStatus(t.slug, "archived");
    const res = await fetch(`http://127.0.0.1:${cpPort}/anything`, {
      headers: { "x-tenant-slug": t.slug },
    });
    expect(res.status).toBe(410);
  });

  it("proxies to a running upstream when tenant is running", async () => {
    const t = await manager.create({ email: "proxy@x.com", plan: "trial" });
    // Force the tenant to "running" status pointing at a fake upstream on
    // its assigned port. We bypass TenantManager.start (which would try
    // to spawn the real daemora binary) by flipping status directly and
    // running our own server on the tenant's port.
    const upstream = startUpstream(t.port, (path, method) => {
      return { status: 200, body: `hi ${method} ${path}` };
    });
    upstreams.push(upstream);
    manager.registry.setStatus(t.slug, "running");
    await new Promise((r) => setTimeout(r, 50));

    const res = await fetch(`http://127.0.0.1:${cpPort}/foo/bar`, {
      headers: { "x-tenant-slug": t.slug },
    });
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe("hi GET /foo/bar");
  });

  it("returns 502 when running tenant is unreachable (upstream down)", async () => {
    const t = await manager.create({ email: "down@x.com", plan: "trial" });
    manager.registry.setStatus(t.slug, "running"); // status says running…
    // …but nothing is actually listening on the port.

    const res = await fetch(`http://127.0.0.1:${cpPort}/anything`, {
      headers: { "x-tenant-slug": t.slug },
    });
    expect(res.status).toBe(502);
  });

  it("resolves tenant via subdomain matching hostSuffix", async () => {
    const t = await manager.create({ email: "sub@x.com", plan: "trial" });
    const upstream = startUpstream(t.port, () => ({ status: 200, body: "ok" }));
    upstreams.push(upstream);
    manager.registry.setStatus(t.slug, "running");
    await new Promise((r) => setTimeout(r, 50));

    // Manually construct a Host header that maps onto our tenant slug.
    // Fetch in Node doesn't allow overriding Host on localhost trivially,
    // so we send via raw http with the Host header.
    const http = await import("node:http");
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: cpPort,
          method: "GET",
          path: "/",
          headers: { host: `${t.slug}.test.local` },
        },
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c) => chunks.push(c as Buffer));
          r.on("end", () =>
            resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });
});
