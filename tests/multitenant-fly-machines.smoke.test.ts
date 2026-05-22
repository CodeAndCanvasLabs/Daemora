/**
 * FlyMachinesClient — wire-format tests (no real Fly).
 *
 *  - createMachine: idempotent on slug, correct request body
 *  - waitForState: polls until target, errors on destroyed
 *  - ensureTenantVolume: returns existing or creates
 *  - tenantFlycastUrl: builds the right internal address
 */

import { describe, expect, it } from "vitest";
import { FlyMachinesClient, tenantFlycastUrl, FlyMachinesError } from "../src/multitenant/FlyMachinesClient.js";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function fakeFetch(handler: (call: Call) => { status: number; body: unknown }): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f: typeof fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = handler(call);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: f, calls };
}

function newClient(fakeFetchFn: typeof fetch) {
  return new FlyMachinesClient({
    apiToken: "test-token",
    tenantAppName: "daemora-tenants",
    region: "iad",
    tenantImage: "registry.fly.io/daemora-tenants:latest",
    fetch: fakeFetchFn,
  });
}

describe("FlyMachinesClient.createMachine", () => {
  it("creates a new machine with the expected payload", async () => {
    const { fetch: ff, calls } = fakeFetch((call) => {
      if (call.method === "GET" && call.url.endsWith("/machines")) {
        return { status: 200, body: [] };               // no existing machines
      }
      return { status: 200, body: { id: "m-1", name: "alice", state: "created", region: "iad", private_ip: "fdaa::1" } };
    });
    const client = newClient(ff);
    const machine = await client.createMachine({
      slug: "alice",
      env: { DAEMORA_TENANT_ID: "t-1" },
    });

    expect(machine.id).toBe("m-1");
    expect(calls).toHaveLength(2);
    const create = calls[1]!;
    expect(create.url).toBe("https://api.machines.dev/v1/apps/daemora-tenants/machines");
    expect(create.method).toBe("POST");
    const body = create.body as { name: string; region: string; config: { env: Record<string, string>; image: string; guest: { cpus: number; memory_mb: number } } };
    expect(body.name).toBe("alice");
    expect(body.region).toBe("iad");
    expect(body.config.image).toBe("registry.fly.io/daemora-tenants:latest");
    expect(body.config.env.DAEMORA_TENANT_ID).toBe("t-1");
    expect(body.config.guest.cpus).toBe(1);
    expect(body.config.guest.memory_mb).toBe(512);
  });

  it("returns existing machine when one with the same slug already exists (idempotent)", async () => {
    const existing = { id: "m-existing", name: "alice", state: "started", region: "iad", private_ip: "fdaa::2" };
    const { fetch: ff, calls } = fakeFetch((call) => {
      if (call.method === "GET" && call.url.endsWith("/machines")) {
        return { status: 200, body: [existing] };
      }
      throw new Error("should not POST to create when an existing machine matched");
    });
    const client = newClient(ff);
    const machine = await client.createMachine({ slug: "alice", env: {} });
    expect(machine.id).toBe("m-existing");
    expect(calls).toHaveLength(1);                       // only the list call
  });

  it("attaches a volume when volumeId is provided", async () => {
    const { fetch: ff, calls } = fakeFetch((call) => {
      if (call.method === "GET") return { status: 200, body: [] };
      return { status: 200, body: { id: "m-2", name: "bob", state: "created", region: "iad", private_ip: "fdaa::3" } };
    });
    const client = newClient(ff);
    await client.createMachine({ slug: "bob", env: {}, volumeId: "vol_123" });
    const body = calls[1]!.body as { config: { mounts?: Array<{ volume: string; path: string }> } };
    expect(body.config.mounts).toEqual([{ volume: "vol_123", path: "/data" }]);
  });
});

describe("FlyMachinesClient.waitForState", () => {
  it("returns once the machine reaches the target state", async () => {
    let pollCount = 0;
    const { fetch: ff } = fakeFetch(() => {
      pollCount++;
      return {
        status: 200,
        body: { id: "m-1", name: "alice", state: pollCount < 2 ? "starting" : "started", region: "iad", private_ip: "fdaa::1" },
      };
    });
    const client = newClient(ff);
    const m = await client.waitForState("m-1", "started", 5_000);
    expect(m.state).toBe("started");
    expect(pollCount).toBeGreaterThanOrEqual(2);
  });

  it("throws if the machine is destroyed while waiting", async () => {
    const { fetch: ff } = fakeFetch(() => ({
      status: 200,
      body: { id: "m-1", name: "alice", state: "destroyed", region: "iad", private_ip: "fdaa::1" },
    }));
    const client = newClient(ff);
    await expect(client.waitForState("m-1", "started", 5_000))
      .rejects.toBeInstanceOf(FlyMachinesError);
  });
});

describe("FlyMachinesClient.ensureTenantVolume", () => {
  it("returns existing volume when one matches the slug-derived name", async () => {
    const existing = { id: "vol_existing", name: "alice_data", region: "iad", size_gb: 3 };
    const { fetch: ff, calls } = fakeFetch(() => ({ status: 200, body: [existing] }));
    const client = newClient(ff);
    const v = await client.ensureTenantVolume("alice");
    expect(v.id).toBe("vol_existing");
    expect(calls).toHaveLength(1);                       // only list, no create
  });

  it("creates a new volume when none exists", async () => {
    const { fetch: ff, calls } = fakeFetch((call) => {
      if (call.method === "GET") return { status: 200, body: [] };
      return { status: 200, body: { id: "vol_new", name: "alice_data", region: "iad", size_gb: 5 } };
    });
    const client = newClient(ff);
    const v = await client.ensureTenantVolume("alice", 5);
    expect(v.id).toBe("vol_new");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.method).toBe("POST");
    const body = calls[1]!.body as { name: string; size_gb: number; region: string };
    expect(body.name).toBe("alice_data");
    expect(body.size_gb).toBe(5);
  });
});

describe("FlyMachinesClient error handling", () => {
  it("throws FlyMachinesError on non-2xx responses with body detail", async () => {
    const { fetch: ff } = fakeFetch(() => ({ status: 403, body: { error: "insufficient_scope" } }));
    const client = newClient(ff);
    await expect(client.listMachines()).rejects.toMatchObject({
      name: "FlyMachinesError",
      status: 403,
    });
  });
});

describe("tenantFlycastUrl", () => {
  it("builds the correct internal address", () => {
    expect(tenantFlycastUrl({ slug: "alice", tenantAppName: "daemora-tenants" }))
      .toBe("http://alice.vm.daemora-tenants.internal:8081");
  });

  it("respects port override", () => {
    expect(tenantFlycastUrl({ slug: "bob", tenantAppName: "daemora-tenants", port: 9000 }))
      .toBe("http://bob.vm.daemora-tenants.internal:9000");
  });
});
