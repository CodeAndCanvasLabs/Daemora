import { describe, it, expect } from "vitest";
import tenantContext from "../../src/tenants/TenantContext.js";
import { logCost, getTenantTodayCost } from "../../src/core/CostTracker.js";
import filesystemGuard from "../../src/safety/FilesystemGuard.js";

/**
 * Integration tests — verify multi-tenant isolation guarantees:
 *   1. TenantContext isolates store across concurrent tasks
 *   2. CostTracker per-tenant sums don't bleed between tenants
 *   3. FilesystemGuard uses per-tenant allowed/blocked paths from TenantContext
 */

describe("Multi-tenant isolation", () => {
  describe("TenantContext — concurrent task isolation", () => {
    it("two concurrent tasks see their own tenant IDs", async () => {
      const captured = {};

      await Promise.all([
        tenantContext.run({ tenant: { id: "telegram:alice" }, resolvedConfig: {} }, async () => {
          await new Promise((r) => setTimeout(r, 10));
          captured.alice = tenantContext.getStore().tenant.id;
        }),
        tenantContext.run({ tenant: { id: "slack:bob" }, resolvedConfig: {} }, async () => {
          await new Promise((r) => setTimeout(r, 5));
          captured.bob = tenantContext.getStore().tenant.id;
        }),
      ]);

      expect(captured.alice).toBe("telegram:alice");
      expect(captured.bob).toBe("slack:bob");
    });

    it("two concurrent tasks see their own apiKeys", async () => {
      const seen = {};

      await Promise.all([
        tenantContext.run({ tenant: { id: "t:k1" }, apiKeys: { OPENAI_API_KEY: "sk-key-for-k1" } }, async () => {
          await new Promise((r) => setTimeout(r, 8));
          seen.k1 = tenantContext.getStore().apiKeys.OPENAI_API_KEY;
        }),
        tenantContext.run({ tenant: { id: "t:k2" }, apiKeys: { OPENAI_API_KEY: "sk-key-for-k2" } }, async () => {
          await new Promise((r) => setTimeout(r, 3));
          seen.k2 = tenantContext.getStore().apiKeys.OPENAI_API_KEY;
        }),
      ]);

      expect(seen.k1).toBe("sk-key-for-k1");
      expect(seen.k2).toBe("sk-key-for-k2");
    });
  });

  describe("CostTracker — per-tenant isolation", () => {
    it("cost logged for tenant A does not appear in tenant B's total", () => {
      const tenantA = `integration:costA_${Date.now()}`;
      const tenantB = `integration:costB_${Date.now()}`;

      logCost({ taskId: "ta1", modelId: "openai:gpt-4.1-mini", inputTokens: 500, outputTokens: 200, estimatedCost: 0.20, tenantId: tenantA });

      expect(getTenantTodayCost(tenantB)).toBe(0);
      expect(getTenantTodayCost(tenantA)).toBeGreaterThanOrEqual(0.20);
    });

    it("multiple log entries for same tenant accumulate", () => {
      const tenantId = `integration:multilog_${Date.now()}`;

      logCost({ taskId: "m1", modelId: "openai:gpt-4.1-mini", inputTokens: 100, outputTokens: 50, estimatedCost: 0.10, tenantId });
      logCost({ taskId: "m2", modelId: "openai:gpt-4.1-mini", inputTokens: 100, outputTokens: 50, estimatedCost: 0.15, tenantId });
      logCost({ taskId: "m3", modelId: "openai:gpt-4.1-mini", inputTokens: 100, outputTokens: 50, estimatedCost: 0.05, tenantId });

      const total = getTenantTodayCost(tenantId);
      expect(total).toBeCloseTo(0.30, 5);
    });
  });

  describe("FilesystemGuard — per-tenant path scoping via TenantContext", () => {
    it("allows file access when inside allowedPaths", async () => {
      const store = {
        tenant: { id: "telegram:pathtest" },
        resolvedConfig: {
          allowedPaths: ["/home/user/workspace"],
          blockedPaths: [],
        },
      };

      let result;
      await tenantContext.run(store, async () => {
        result = filesystemGuard.checkRead("/home/user/workspace/project/src/index.js");
      });

      expect(result.allowed).toBe(true);
    });

    it("blocks file access when outside allowedPaths", async () => {
      const store = {
        tenant: { id: "telegram:restrictedtest" },
        resolvedConfig: {
          allowedPaths: ["/home/user/workspace"],
          blockedPaths: [],
        },
      };

      let result;
      await tenantContext.run(store, async () => {
        result = filesystemGuard.checkRead("/etc/passwd");
      });

      expect(result.allowed).toBe(false);
    });

    it("tenant blockedPaths are enforced", async () => {
      const store = {
        tenant: { id: "telegram:blockedpathtest" },
        resolvedConfig: {
          allowedPaths: [],  // no restriction
          blockedPaths: ["/home/user/private"],
        },
      };

      let result;
      await tenantContext.run(store, async () => {
        result = filesystemGuard.checkRead("/home/user/private/secrets.txt");
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("blocked");
    });

    it("different tenants can have different allowedPaths", async () => {
      const storeA = {
        tenant: { id: "t:pathA" },
        resolvedConfig: { allowedPaths: ["/workspace/teamA"], blockedPaths: [] },
      };
      const storeB = {
        tenant: { id: "t:pathB" },
        resolvedConfig: { allowedPaths: ["/workspace/teamB"], blockedPaths: [] },
      };

      const results = {};

      await Promise.all([
        tenantContext.run(storeA, async () => {
          await new Promise((r) => setTimeout(r, 5));
          results.A_inA = filesystemGuard.checkRead("/workspace/teamA/code.js").allowed;
          results.A_inB = filesystemGuard.checkRead("/workspace/teamB/code.js").allowed;
        }),
        tenantContext.run(storeB, async () => {
          await new Promise((r) => setTimeout(r, 2));
          results.B_inB = filesystemGuard.checkRead("/workspace/teamB/code.js").allowed;
          results.B_inA = filesystemGuard.checkRead("/workspace/teamA/code.js").allowed;
        }),
      ]);

      expect(results.A_inA).toBe(true);  // tenant A can access their workspace
      expect(results.A_inB).toBe(false); // tenant A cannot access tenant B's workspace
      expect(results.B_inB).toBe(true);  // tenant B can access their workspace
      expect(results.B_inA).toBe(false); // tenant B cannot access tenant A's workspace
    });
  });
});
