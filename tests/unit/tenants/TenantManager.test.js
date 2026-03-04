import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, existsSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import os from "os";

/**
 * TenantManager tests.
 *
 * We test the encryption helpers and public API.
 * The module uses `config.dataDir` for storage, so we point tests at a temp dir.
 */

// Helper: create a fresh TenantManager instance pointing at a temp directory.
async function makeTempManager() {
  const tmpDir = join(os.tmpdir(), `daemora-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpDir, "tenants"), { recursive: true });

  // We import TenantManager internals indirectly — the singleton points at real dataDir.
  // Instead, directly test the encryption round-trip using the module's helpers
  // by exposing them via the public setApiKey / getDecryptedApiKeys interface.
  return { tmpDir };
}

describe("TenantManager — encryption (AES-256-GCM)", () => {
  let originalKey;

  beforeEach(() => {
    originalKey = process.env.DAEMORA_TENANT_KEY;
    process.env.DAEMORA_TENANT_KEY = "test-secret-key-for-unit-tests-only";
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.DAEMORA_TENANT_KEY = originalKey;
    } else {
      delete process.env.DAEMORA_TENANT_KEY;
    }
  });

  it("can set and retrieve an API key round-trip", async () => {
    const { default: tenantManager } = await import("../../../src/tenants/TenantManager.js");

    // Use a synthetic tenant ID that won't conflict with real data
    const testTenantId = `test:encrypt_${Date.now()}`;

    // Ensure tenant exists (need to inject it directly since autoRegister may be off)
    // We test via the public interface — setApiKey + getDecryptedApiKeys
    tenantManager.setApiKey(testTenantId, "OPENAI_API_KEY", "sk-test-my-secret-key-123456789");
    const keys = tenantManager.getDecryptedApiKeys(testTenantId);

    expect(keys.OPENAI_API_KEY).toBe("sk-test-my-secret-key-123456789");
  });

  it("stores the key encrypted (not plaintext) in the JSON", async () => {
    const { default: tenantManager } = await import("../../../src/tenants/TenantManager.js");
    const testTenantId = `test:storedencrypted_${Date.now()}`;

    tenantManager.setApiKey(testTenantId, "ANTHROPIC_API_KEY", "sk-ant-plaintext-value");

    // Access raw storage to verify it's not stored as plaintext
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const { config } = await import("../../../src/config/default.js");
    const tenantsPath = join(config.dataDir, "tenants", "tenants.json");
    const raw = readFileSync(tenantsPath, "utf-8");

    expect(raw).not.toContain("sk-ant-plaintext-value");
  });

  it("can set multiple API keys for the same tenant", async () => {
    const { default: tenantManager } = await import("../../../src/tenants/TenantManager.js");
    const testTenantId = `test:multikey_${Date.now()}`;

    tenantManager.setApiKey(testTenantId, "OPENAI_API_KEY", "sk-openai-value-xxx");
    tenantManager.setApiKey(testTenantId, "ANTHROPIC_API_KEY", "sk-ant-api03-value-yyy");

    const keys = tenantManager.getDecryptedApiKeys(testTenantId);
    expect(keys.OPENAI_API_KEY).toBe("sk-openai-value-xxx");
    expect(keys.ANTHROPIC_API_KEY).toBe("sk-ant-api03-value-yyy");
  });

  it("deleteApiKey removes the key", async () => {
    const { default: tenantManager } = await import("../../../src/tenants/TenantManager.js");
    const testTenantId = `test:deletekey_${Date.now()}`;

    tenantManager.setApiKey(testTenantId, "OPENAI_API_KEY", "sk-to-delete");
    tenantManager.deleteApiKey(testTenantId, "OPENAI_API_KEY");

    const keys = tenantManager.getDecryptedApiKeys(testTenantId);
    expect(keys.OPENAI_API_KEY).toBeUndefined();
  });

  it("listApiKeyNames returns key names without values", async () => {
    const { default: tenantManager } = await import("../../../src/tenants/TenantManager.js");
    const testTenantId = `test:listkeys_${Date.now()}`;

    tenantManager.setApiKey(testTenantId, "OPENAI_API_KEY", "sk-a");
    tenantManager.setApiKey(testTenantId, "GOOGLE_AI_API_KEY", "AIza_b");

    const names = tenantManager.listApiKeyNames(testTenantId);
    expect(names).toContain("OPENAI_API_KEY");
    expect(names).toContain("GOOGLE_AI_API_KEY");
    expect(names).not.toContain("sk-a");
    expect(names).not.toContain("AIza_b");
  });

  it("different values produce different ciphertexts (IV randomness)", async () => {
    const { default: tenantManager } = await import("../../../src/tenants/TenantManager.js");
    const t1 = `test:diff1_${Date.now()}`;
    const t2 = `test:diff2_${Date.now()}`;

    tenantManager.setApiKey(t1, "OPENAI_API_KEY", "sk-same-value");
    tenantManager.setApiKey(t2, "OPENAI_API_KEY", "sk-same-value");

    // Both tenants store same value — ciphertexts should differ (random IV)
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const { config } = await import("../../../src/config/default.js");
    const raw = JSON.parse(readFileSync(join(config.dataDir, "tenants", "tenants.json"), "utf-8"));

    const cipher1 = raw[t1]?.encryptedApiKeys?.OPENAI_API_KEY;
    const cipher2 = raw[t2]?.encryptedApiKeys?.OPENAI_API_KEY;
    expect(cipher1).toBeDefined();
    expect(cipher2).toBeDefined();
    expect(cipher1).not.toBe(cipher2); // different IVs → different ciphertexts
  });

  it("decryption returns null for tampered ciphertext", async () => {
    const { default: tenantManager } = await import("../../../src/tenants/TenantManager.js");
    const testTenantId = `test:tampered_${Date.now()}`;

    tenantManager.setApiKey(testTenantId, "OPENAI_API_KEY", "sk-original");

    // Tamper with the ciphertext in storage
    const { readFileSync, writeFileSync } = await import("fs");
    const { join } = await import("path");
    const { config } = await import("../../../src/config/default.js");
    const tenantsPath = join(config.dataDir, "tenants", "tenants.json");
    const raw = JSON.parse(readFileSync(tenantsPath, "utf-8"));
    raw[testTenantId].encryptedApiKeys.OPENAI_API_KEY = "badhex:badhex:badhex";
    writeFileSync(tenantsPath, JSON.stringify(raw, null, 2));
    tenantManager._cache = null; // invalidate cache

    const keys = tenantManager.getDecryptedApiKeys(testTenantId);
    expect(keys.OPENAI_API_KEY).toBeUndefined(); // tampered = silently dropped
  });
});

describe("TenantManager — resolveTaskConfig()", () => {
  it("returns empty apiKeys for null tenant", async () => {
    const { default: tenantManager } = await import("../../../src/tenants/TenantManager.js");
    const resolved = tenantManager.resolveTaskConfig(null, null);
    expect(resolved.apiKeys).toEqual({});
  });

  it("returns null for mcpServers when tenant has no restriction", async () => {
    const { default: tenantManager } = await import("../../../src/tenants/TenantManager.js");
    const resolved = tenantManager.resolveTaskConfig(null, null);
    expect(resolved.mcpServers).toBeNull();
  });

  it("uses channel model when tenant has no model override", async () => {
    const { default: tenantManager } = await import("../../../src/tenants/TenantManager.js");
    const resolved = tenantManager.resolveTaskConfig(null, "openai:gpt-4.1");
    expect(resolved.model).toBe("openai:gpt-4.1");
  });

  it("uses tenant model over channel model", async () => {
    const { default: tenantManager } = await import("../../../src/tenants/TenantManager.js");
    const fakeTenant = {
      id: "telegram:fake",
      model: "anthropic:claude-sonnet-4-6",
      allowedPaths: [],
      blockedPaths: [],
      mcpServers: null,
      modelRoutes: null,
      suspended: false,
    };
    const resolved = tenantManager.resolveTaskConfig(fakeTenant, "openai:gpt-4.1");
    expect(resolved.model).toBe("anthropic:claude-sonnet-4-6");
  });
});

describe("TenantManager — stats()", () => {
  it("returns total, suspended, totalCost, totalTasks", async () => {
    const { default: tenantManager } = await import("../../../src/tenants/TenantManager.js");
    const s = tenantManager.stats();
    expect(typeof s.total).toBe("number");
    expect(typeof s.suspended).toBe("number");
    expect(typeof s.totalCost).toBe("string"); // toFixed(4) returns string
    expect(typeof s.totalTasks).toBe("number");
  });
});
