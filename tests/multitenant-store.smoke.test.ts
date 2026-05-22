/**
 * Phase 2: TenantStore + MasterKeyVault smoke tests.
 *
 * Covers:
 *  - tenant create, list, find by slug/email/port
 *  - status transitions + audit events
 *  - config CRUD
 *  - API-key CRUD with master-KEK encryption (round-trip)
 *  - port uniqueness + slug uniqueness + email uniqueness
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { describe, expect, it, beforeEach } from "vitest";

import { TenantStore } from "../src/multitenant/TenantStore.js";
import { MasterKeyVault, generateMasterKek } from "../src/multitenant/MasterKeyVault.js";

function freshStore(): { store: TenantStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "daemora-tenant-store-"));
  const store = new TenantStore(join(root, "tenants.db"));
  return { store, root };
}

describe("TenantStore — create + read", () => {
  it("creates a tenant with a generated slug from email", () => {
    const { store, root } = freshStore();
    const tenant = store.create({ email: "alice@daemora.com", plan: "trial" }, root);
    expect(tenant.email).toBe("alice@daemora.com");
    expect(tenant.slug).toContain("alice");
    expect(tenant.port).toBeGreaterThanOrEqual(8101);
    expect(tenant.status).toBe("provisioning");
    expect(tenant.dataDir).toContain("tenants");
  });

  it("rejects duplicate email", () => {
    const { store, root } = freshStore();
    store.create({ email: "alice@daemora.com", plan: "trial" }, root);
    expect(() => store.create({ email: "alice@daemora.com", plan: "trial" }, root)).toThrow(/already exists/);
  });

  it("rejects duplicate slug", () => {
    const { store, root } = freshStore();
    store.create({ email: "alice@daemora.com", plan: "trial", slug: "alice" }, root);
    expect(() =>
      store.create({ email: "alice2@daemora.com", plan: "trial", slug: "alice" }, root),
    ).toThrow(/already exists/);
  });

  it("assigns unique ports across tenants", () => {
    const { store, root } = freshStore();
    const a = store.create({ email: "a@x.com", plan: "trial" }, root);
    const b = store.create({ email: "b@x.com", plan: "trial" }, root);
    const c = store.create({ email: "c@x.com", plan: "trial" }, root);
    const ports = new Set([a.port, b.port, c.port]);
    expect(ports.size).toBe(3);
  });

  it("finds by slug, email, port", () => {
    const { store, root } = freshStore();
    const created = store.create({ email: "alice@daemora.com", plan: "pro" }, root);
    expect(store.findBySlug(created.slug)?.email).toBe(created.email);
    expect(store.findByEmail(created.email)?.slug).toBe(created.slug);
    expect(store.findByPort(created.port)?.id).toBe(created.id);
  });

  it("lists tenants ordered by creation", () => {
    const { store, root } = freshStore();
    store.create({ email: "a@x.com", plan: "trial" }, root);
    store.create({ email: "b@x.com", plan: "lite" }, root);
    const list = store.list();
    expect(list.map((t) => t.email)).toEqual(["a@x.com", "b@x.com"]);
  });

  it("filters list by status", () => {
    const { store, root } = freshStore();
    const a = store.create({ email: "a@x.com", plan: "trial" }, root);
    store.create({ email: "b@x.com", plan: "trial" }, root);
    store.setStatus(a.slug, "suspended", "test");
    expect(store.list({ status: "suspended" }).map((t) => t.email)).toEqual(["a@x.com"]);
  });
});

describe("TenantStore — status + events", () => {
  it("flips status + records audit event", () => {
    const { store, root } = freshStore();
    const t = store.create({ email: "alice@daemora.com", plan: "trial" }, root);
    store.setStatus(t.slug, "running");
    expect(store.findBySlug(t.slug)?.status).toBe("running");
    const events = store.recentEvents(t.slug);
    expect(events.map((e) => e.kind)).toContain("running");
  });

  it("records suspend reason", () => {
    const { store, root } = freshStore();
    const t = store.create({ email: "alice@daemora.com", plan: "trial" }, root);
    store.setStatus(t.slug, "suspended", "trial expired");
    const got = store.findBySlug(t.slug);
    expect(got?.suspendReason).toBe("trial expired");
    expect(got?.suspendedAt).toBeTruthy();
  });
});

describe("TenantStore — config", () => {
  it("round-trips config values", () => {
    const { store, root } = freshStore();
    const t = store.create({ email: "alice@daemora.com", plan: "trial" }, root);
    store.setConfig(t.slug, "maxDailyCost", 5.0);
    store.setConfig(t.slug, "profileId", "companion");
    store.setConfig(t.slug, "tools", ["webSearch", "writeFile"]);
    expect(store.getConfig(t.slug, "maxDailyCost")).toBe(5.0);
    expect(store.getConfig(t.slug, "profileId")).toBe("companion");
    expect(store.getConfig(t.slug, "tools")).toEqual(["webSearch", "writeFile"]);
  });

  it("upserts config — second set replaces the first", () => {
    const { store, root } = freshStore();
    const t = store.create({ email: "alice@daemora.com", plan: "trial" }, root);
    store.setConfig(t.slug, "maxDailyCost", 1.0);
    store.setConfig(t.slug, "maxDailyCost", 7.5);
    expect(store.getConfig(t.slug, "maxDailyCost")).toBe(7.5);
  });

  it("getAllConfig returns the full map", () => {
    const { store, root } = freshStore();
    const t = store.create({ email: "alice@daemora.com", plan: "trial" }, root);
    store.setConfig(t.slug, "a", 1);
    store.setConfig(t.slug, "b", "two");
    expect(store.getAllConfig(t.slug)).toEqual({ a: 1, b: "two" });
  });
});

describe("MasterKeyVault — encryption + integration with TenantStore", () => {
  it("round-trips a value", () => {
    const vault = new MasterKeyVault(randomBytes(32));
    const { ciphertext, nonce } = vault.encrypt("tenant-1", "OPENAI_API_KEY", "sk-test");
    expect(vault.decrypt("tenant-1", "OPENAI_API_KEY", ciphertext, nonce)).toBe("sk-test");
  });

  it("uses different subkeys per tenant (same plaintext → different ciphertext)", () => {
    const vault = new MasterKeyVault(randomBytes(32));
    const a = vault.encrypt("tenant-1", "K", "secret");
    const b = vault.encrypt("tenant-2", "K", "secret");
    expect(Buffer.compare(a.ciphertext, b.ciphertext)).not.toBe(0);
  });

  it("decryption fails with a different tenant id (HKDF binding)", () => {
    const vault = new MasterKeyVault(randomBytes(32));
    const { ciphertext, nonce } = vault.encrypt("tenant-1", "K", "secret");
    expect(() => vault.decrypt("tenant-2", "K", ciphertext, nonce)).toThrow();
  });

  it("decryption fails with a different key name", () => {
    const vault = new MasterKeyVault(randomBytes(32));
    const { ciphertext, nonce } = vault.encrypt("tenant-1", "K1", "secret");
    expect(() => vault.decrypt("tenant-1", "K2", ciphertext, nonce)).toThrow();
  });

  it("rejects a corrupted ciphertext (GCM auth tag check)", () => {
    const vault = new MasterKeyVault(randomBytes(32));
    const { ciphertext, nonce } = vault.encrypt("tenant-1", "K", "secret");
    const tampered = Buffer.from(ciphertext);
    tampered[0] = tampered[0]! ^ 1;
    expect(() => vault.decrypt("tenant-1", "K", tampered, nonce)).toThrow();
  });

  it("rejects MASTER_KEK of wrong length", () => {
    expect(() => new MasterKeyVault(randomBytes(16))).toThrow();
  });

  it("loads from env when MASTER_KEK is set", () => {
    const kek = generateMasterKek();
    const v = MasterKeyVault.fromEnv({ MASTER_KEK: kek });
    expect(v.selfTest()).toBe(true);
  });

  it("integrates with TenantStore (encrypted API key round-trip)", () => {
    const { store, root } = freshStore();
    const vault = new MasterKeyVault(randomBytes(32));
    const t = store.create({ email: "alice@daemora.com", plan: "pro" }, root);

    const { ciphertext, nonce } = vault.encrypt(t.id, "OPENAI_API_KEY", "sk-real-key");
    store.putApiKey(t.slug, "OPENAI_API_KEY", ciphertext, nonce);

    const fetched = store.getApiKey(t.slug, "OPENAI_API_KEY");
    expect(fetched).toBeTruthy();
    const decrypted = vault.decrypt(t.id, "OPENAI_API_KEY", fetched!.ciphertext, fetched!.nonce);
    expect(decrypted).toBe("sk-real-key");
  });

  it("listApiKeyNames returns names only — never values", () => {
    const { store, root } = freshStore();
    const vault = new MasterKeyVault(randomBytes(32));
    const t = store.create({ email: "alice@daemora.com", plan: "pro" }, root);

    const { ciphertext: c1, nonce: n1 } = vault.encrypt(t.id, "OPENAI_API_KEY", "sk-1");
    const { ciphertext: c2, nonce: n2 } = vault.encrypt(t.id, "ANTHROPIC_API_KEY", "sk-2");
    store.putApiKey(t.slug, "OPENAI_API_KEY", c1, n1);
    store.putApiKey(t.slug, "ANTHROPIC_API_KEY", c2, n2);

    const names = store.listApiKeyNames(t.slug);
    expect(names.sort()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    // Cannot accidentally leak values through the names API:
    for (const n of names) {
      expect(n).not.toContain("sk-");
    }
  });

  it("deletes API keys", () => {
    const { store, root } = freshStore();
    const vault = new MasterKeyVault(randomBytes(32));
    const t = store.create({ email: "alice@daemora.com", plan: "pro" }, root);
    const { ciphertext, nonce } = vault.encrypt(t.id, "K", "v");
    store.putApiKey(t.slug, "K", ciphertext, nonce);
    store.deleteApiKey(t.slug, "K");
    expect(store.listApiKeyNames(t.slug)).toEqual([]);
  });
});

describe("TenantStore — hard delete cascades", () => {
  it("removes config + api keys + events when tenant is hard-deleted", () => {
    const { store, root } = freshStore();
    const vault = new MasterKeyVault(randomBytes(32));
    const t = store.create({ email: "alice@daemora.com", plan: "pro" }, root);
    store.setConfig(t.slug, "k", 1);
    const { ciphertext, nonce } = vault.encrypt(t.id, "K", "v");
    store.putApiKey(t.slug, "K", ciphertext, nonce);

    store.hardDelete(t.slug);
    expect(store.findBySlug(t.slug)).toBeUndefined();
    // Subsequent gets throw because the tenant is gone.
    expect(() => store.getAllConfig(t.slug)).toThrow();
  });
});
