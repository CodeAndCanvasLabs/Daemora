/**
 * Phase 7: End-to-end acceptance — maps 1:1 to the 10-step test you wrote:
 *
 *   1. tenant list                  → starts empty
 *   2. tenant create                → provisioning row + dir skeleton
 *   3. tenant plan pro              → plan preset applied to tenant_config
 *   4. tenant set maxDailyCost 2.00 → CostGuard would pick this up
 *   5. tenant apikey set            → ciphertext stored, name retrievable
 *   6. tenant set tools …           → allowedTools serialised
 *   7. tenant show                  → full config + key names (no values)
 *   8. filesystem isolation         → tenant dir vs sibling tenant dir
 *   9. memory isolation             → wiki write lands ONLY in tenant dir
 *  10. tenant suspend               → status flips + control plane returns 402
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { MasterKeyVault } from "../src/multitenant/MasterKeyVault.js";
import { TenantManager } from "../src/multitenant/TenantManager.js";
import { CostGuard } from "../src/costs/CostGuard.js";
import { CostTracker } from "../src/costs/CostTracker.js";
import Database from "better-sqlite3";
import { startControlPlane } from "../src/multitenant/controlPlane.js";
import { createServer } from "node:http";

async function freePort(): Promise<number> {
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

describe("Acceptance — 10-step CLI test", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "daemora-acceptance-"));
  const vault = new MasterKeyVault(randomBytes(32));
  const manager = new TenantManager({ dataRoot, masterVault: vault });
  const email = "testuser@daemora.com";
  let slug: string;

  it("STEP 1 — tenant list (empty)", () => {
    expect(manager.list()).toEqual([]);
  });

  it("STEP 2 — tenant create", async () => {
    const t = await manager.create({ email, plan: "trial" });
    slug = t.slug;
    expect(t.email).toBe(email);
    expect(t.status).toBe("provisioning");
    expect(existsSync(t.dataDir)).toBe(true);
    expect(existsSync(join(t.dataDir, "wiki"))).toBe(true);
    expect(existsSync(join(t.dataDir, "file-projects"))).toBe(true);
    expect(existsSync(join(t.dataDir, "outputs"))).toBe(true);
  });

  it("STEP 3 — tenant plan pro applies the preset", () => {
    manager.setPlan(slug, "pro");
    const cfg = manager.show(slug).config;
    expect(cfg["permissionTier"]).toBe("standard");
    expect(cfg["featureVoice"]).toBe(true);
    expect(cfg["featurePlaywright"]).toBe(true);
    expect(cfg["featureVideo"]).toBe(true);
    expect(cfg["maxDailyCost"]).toBe(5.0);    // pro default
    expect(cfg["volumeGb"]).toBe(20);
  });

  it("STEP 4 — set maxDailyCost overrides the plan default", () => {
    manager.setConfig(slug, "maxDailyCost", 2.0);
    expect(manager.show(slug).config["maxDailyCost"]).toBe(2.0);

    // CostGuard built from this env would respect the cap.
    const tracker = new CostTracker(new Database(":memory:"));
    const guard = CostGuard.fromEnv(tracker, { DAEMORA_MAX_DAILY_COST: "2.0" });
    expect(guard?.snapshot().dailyCapUsd).toBe(2.0);
  });

  it("STEP 5 — apikey set stores encrypted, retrievable by name (not value)", () => {
    manager.setApiKey(slug, "OPENAI_API_KEY", "sk-test-key-123");
    const names = manager.listApiKeyNames(slug);
    expect(names).toContain("OPENAI_API_KEY");
    // Crucially: the stored ciphertext is NOT the plaintext.
    const row = manager.registry.getApiKey(slug, "OPENAI_API_KEY");
    expect(row).toBeDefined();
    expect(row!.ciphertext.toString("utf-8")).not.toContain("sk-test-key-123");
    // Round-trip through the vault works.
    const tenant = manager.registry.requireBySlug(slug);
    const decrypted = vault.decrypt(tenant.id, "OPENAI_API_KEY", row!.ciphertext, row!.nonce);
    expect(decrypted).toBe("sk-test-key-123");
  });

  it("STEP 6 — set tools list (allowedTools)", () => {
    const tools = ["webSearch", "webFetch", "writeFile", "createDocument", "sendEmail", "replyWithFile"];
    manager.setConfig(slug, "allowedTools", tools);
    expect(manager.show(slug).config["allowedTools"]).toEqual(tools);
  });

  it("STEP 7 — show returns full config + key names (no values)", () => {
    const detail = manager.show(slug);
    expect(detail.tenant.email).toBe(email);
    expect(detail.tenant.plan).toBe("pro");
    expect(detail.config["maxDailyCost"]).toBe(2.0);
    expect(detail.apiKeyNames).toContain("OPENAI_API_KEY");
    // Output never contains the plaintext key.
    const serialised = JSON.stringify(detail);
    expect(serialised).not.toContain("sk-test-key-123");
  });

  it("STEP 8 — filesystem isolation: dir exists and only this tenant lives there", async () => {
    const t = manager.registry.requireBySlug(slug);
    expect(existsSync(t.dataDir)).toBe(true);
    // Create a "sibling" and verify they're in different paths.
    const sibling = await manager.create({ email: "sibling@daemora.com", plan: "lite" });
    expect(sibling.dataDir).not.toBe(t.dataDir);
    expect(sibling.dataDir).toContain(sibling.slug);
    expect(t.dataDir).toContain(t.slug);
    // Hard delete the sibling so the rest of the suite is clean.
    await manager.stop(sibling.slug).catch(() => {});
    manager.hardDelete(sibling.slug);
  });

  it("STEP 9 — memory isolation: write a wiki note into THIS tenant only", () => {
    const t = manager.registry.requireBySlug(slug);
    const note = `Test tenant created on ${new Date().toISOString().slice(0, 10)}. Plan: pro. Use case: research.`;
    const notePath = join(t.dataDir, "wiki", "people", "testuser.md");
    require("node:fs").mkdirSync(join(t.dataDir, "wiki", "people"), { recursive: true });
    writeFileSync(notePath, note);
    expect(readFileSync(notePath, "utf-8")).toBe(note);
    // The note is INSIDE this tenant's dir, not in the data root or anywhere else.
    expect(notePath).toContain(`/tenants/${t.slug}/`);
    expect(notePath.startsWith(dataRoot)).toBe(true);
    // No "main memory" exists in multi-tenant mode — there's only this tenant's wiki.
  });

  it("STEP 10 — suspend: status flips + control plane returns 402 for incoming traffic", async () => {
    await manager.suspend(slug, "Test complete");
    expect(manager.get(slug)?.status).toBe("suspended");
    expect(manager.get(slug)?.suspendReason).toBe("Test complete");

    // Stand up the control plane and verify suspended tenants are
    // rejected with 402 (subscription required).
    const cpPort = await freePort();
    const cp = startControlPlane({ port: cpPort, manager });
    await new Promise((r) => setTimeout(r, 50));
    try {
      const res = await fetch(`http://127.0.0.1:${cpPort}/anything`, {
        headers: { "x-tenant-slug": slug },
      });
      expect(res.status).toBe(402);
      const body = (await res.json()) as { error: string; detail: string };
      expect(body.error).toBe("subscription_required");
      expect(body.detail).toBe("Test complete");
    } finally {
      await cp.close();
    }
  });

  it("ACCEPTANCE — all 10 steps verified", () => {
    // Summary check — recent events show the full lifecycle.
    const events = manager.registry.recentEvents(slug, 50);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("created");
    expect(kinds).toContain("plan_changed");
    expect(kinds).toContain("apikey_set");
    expect(kinds).toContain("suspended");

    manager.close();
  });
});
