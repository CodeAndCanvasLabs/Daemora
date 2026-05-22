/**
 * ControlPlaneClient tests — verify wire-format only. The actual
 * control plane is exercised by tests in src/multitenant/. Here we
 * just confirm:
 *
 *   - admin bearer is attached on every call
 *   - JSON body / content-type set when body is present
 *   - URL paths encode the slug
 *   - non-2xx → throws with status + body
 */

import { describe, it, expect } from "vitest";
import { ControlPlaneClient } from "../src/services/controlPlaneClient.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakeFetch(
  responder: () => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true } }),
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k]!;
    }
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const r = responder();
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: f, calls };
}

describe("ControlPlaneClient", () => {
  it("attaches admin bearer + content-type on POST with body", async () => {
    const { fetch: ff, calls } = fakeFetch(() => ({
      status: 200,
      body: { id: "t1", slug: "alice", port: 8101, status: "running", dataDir: "/srv/t1" },
    }));
    const cp = new ControlPlaneClient({ baseUrl: "http://cp", adminToken: "secret", fetch: ff });
    await cp.provision({ email: "a@x.com", plan: "trial" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://cp/admin/tenants");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer secret");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ email: "a@x.com", plan: "trial" });
  });

  it("omits content-type on bodyless GET", async () => {
    const { fetch: ff, calls } = fakeFetch(() => ({ status: 200, body: { tenants: [] } }));
    const cp = new ControlPlaneClient({ baseUrl: "http://cp", adminToken: "secret", fetch: ff });
    await cp.list();

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers["content-type"]).toBeUndefined();
    expect(calls[0]?.body).toBeUndefined();
  });

  it("URL-encodes the slug in path params", async () => {
    const { fetch: ff, calls } = fakeFetch();
    const cp = new ControlPlaneClient({ baseUrl: "http://cp", adminToken: "t", fetch: ff });
    await cp.suspend("acme corp/v2", "trial_expired");
    expect(calls[0]?.url).toBe("http://cp/admin/tenants/acme%20corp%2Fv2/suspend");
  });

  it("throws on non-2xx with status + body in the message", async () => {
    const { fetch: ff } = fakeFetch(() => ({ status: 500, body: "boom" }));
    const cp = new ControlPlaneClient({ baseUrl: "http://cp", adminToken: "t", fetch: ff });
    await expect(cp.start("alice")).rejects.toThrow(/control-plane POST .* failed: 500/);
  });

  it("start / stop / suspend hit the right paths and methods", async () => {
    const { fetch: ff, calls } = fakeFetch();
    const cp = new ControlPlaneClient({ baseUrl: "http://cp", adminToken: "t", fetch: ff });
    await cp.start("alice");
    await cp.stop("alice");
    await cp.suspend("alice", "manual");
    await cp.show("alice");

    expect(calls.map((c) => `${c.method} ${c.url.replace("http://cp", "")}`)).toEqual([
      "POST /admin/tenants/alice/start",
      "POST /admin/tenants/alice/stop",
      "POST /admin/tenants/alice/suspend",
      "GET /admin/tenants/alice",
    ]);
    expect(JSON.parse(calls[2]!.body!)).toEqual({ reason: "manual" });
  });
});
