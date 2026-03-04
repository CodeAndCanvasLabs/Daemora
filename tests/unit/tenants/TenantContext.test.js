import { describe, it, expect } from "vitest";
import tenantContext from "../../../src/tenants/TenantContext.js";

describe("TenantContext (AsyncLocalStorage)", () => {
  it("returns undefined outside of any run() context", () => {
    expect(tenantContext.getStore()).toBeUndefined();
  });

  it("returns the store value inside run()", async () => {
    const store = { tenant: { id: "telegram:123" }, resolvedModel: "openai:gpt-4.1-mini" };

    await tenantContext.run(store, async () => {
      expect(tenantContext.getStore()).toEqual(store);
    });
  });

  it("store is not visible after run() completes", async () => {
    const store = { tenant: { id: "telegram:123" } };
    await tenantContext.run(store, async () => {});
    expect(tenantContext.getStore()).toBeUndefined();
  });

  it("nested run() values shadow the outer context", async () => {
    const outer = { tenant: { id: "outer:1" } };
    const inner = { tenant: { id: "inner:2" } };

    await tenantContext.run(outer, async () => {
      expect(tenantContext.getStore().tenant.id).toBe("outer:1");

      await tenantContext.run(inner, async () => {
        expect(tenantContext.getStore().tenant.id).toBe("inner:2");
      });

      // After inner completes, outer is restored
      expect(tenantContext.getStore().tenant.id).toBe("outer:1");
    });
  });

  it("concurrent run() contexts are isolated", async () => {
    const results = [];

    await Promise.all([
      tenantContext.run({ tenant: { id: "concurrent:A" } }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        results.push(tenantContext.getStore().tenant.id);
      }),
      tenantContext.run({ tenant: { id: "concurrent:B" } }, async () => {
        await new Promise((r) => setTimeout(r, 2));
        results.push(tenantContext.getStore().tenant.id);
      }),
    ]);

    expect(results).toContain("concurrent:A");
    expect(results).toContain("concurrent:B");
    // Each context captured the correct value (not the other tenant's)
    expect(results).toHaveLength(2);
  });

  it("stores apiKeys without cross-contamination between concurrent contexts", async () => {
    const seenKeys = {};

    await Promise.all([
      tenantContext.run({ tenant: { id: "t:1" }, apiKeys: { OPENAI_API_KEY: "sk-tenant-1" } }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seenKeys["t:1"] = tenantContext.getStore().apiKeys.OPENAI_API_KEY;
      }),
      tenantContext.run({ tenant: { id: "t:2" }, apiKeys: { OPENAI_API_KEY: "sk-tenant-2" } }, async () => {
        await new Promise((r) => setTimeout(r, 2));
        seenKeys["t:2"] = tenantContext.getStore().apiKeys.OPENAI_API_KEY;
      }),
    ]);

    expect(seenKeys["t:1"]).toBe("sk-tenant-1");
    expect(seenKeys["t:2"]).toBe("sk-tenant-2");
  });
});
