/**
 * Phase 1: Boot-by-flag verification.
 *
 * Confirms FilesystemGuard `sandbox` mode is tight enough for a tenant
 * daemora subprocess — only the tenant's dataDir (+ explicit extras)
 * is reachable; $HOME, /etc, sibling tenant dirs, install path are all
 * blocked. This is the foundation every later phase rests on.
 */

import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { FilesystemGuard } from "../src/safety/FilesystemGuard.js";
import { BlockedActionError } from "../src/util/errors.js";

describe("FilesystemGuard sandbox mode — tenant isolation foundation", () => {
  let tenantDir: string;
  let otherTenantDir: string;
  let guard: FilesystemGuard;

  beforeEach(() => {
    // Two sibling "tenants" + a real file in each
    const root = mkdtempSync(join(tmpdir(), "daemora-mt-test-"));
    tenantDir = join(root, "alice");
    otherTenantDir = join(root, "bob");
    mkdirSync(tenantDir, { recursive: true });
    mkdirSync(otherTenantDir, { recursive: true });
    writeFileSync(join(tenantDir, "ok.txt"), "alice's file");
    writeFileSync(join(otherTenantDir, "secret.txt"), "bob's secret");

    // The guard a tenant daemora would boot with
    guard = new FilesystemGuard({
      mode: "sandbox",
      dataDir: tenantDir,
      extraAllow: [],
    });
  });

  it("ALLOWS reads inside the tenant dir", () => {
    const canonical = guard.ensureAllowed(join(tenantDir, "ok.txt"), "read");
    expect(canonical).toContain(tenantDir);
  });

  it("ALLOWS writes inside the tenant dir", () => {
    expect(() =>
      guard.ensureAllowed(join(tenantDir, "new.txt"), "write"),
    ).not.toThrow();
  });

  it("BLOCKS reads of a sibling tenant's dir", () => {
    expect(() =>
      guard.ensureAllowed(join(otherTenantDir, "secret.txt"), "read"),
    ).toThrow(BlockedActionError);
  });

  it("BLOCKS reads of /etc/passwd", () => {
    expect(() => guard.ensureAllowed("/etc/passwd", "read")).toThrow(BlockedActionError);
  });

  it("BLOCKS reads of $HOME (sandbox does NOT auto-include home)", () => {
    expect(() => guard.ensureAllowed(homedir(), "read")).toThrow(BlockedActionError);
  });

  it("BLOCKS reads of $HOME/.ssh", () => {
    expect(() =>
      guard.ensureAllowed(join(homedir(), ".ssh", "id_rsa"), "read"),
    ).toThrow(BlockedActionError);
  });

  it("BLOCKS reads of the daemora install dir itself", () => {
    // process.cwd() points at the repo when tests run — emulating
    // "tenant tries to read its own binary".
    expect(() => guard.ensureAllowed(join(process.cwd(), "package.json"), "read")).toThrow(
      BlockedActionError,
    );
  });

  it("BLOCKS path-traversal escapes (..)", () => {
    const escape = join(tenantDir, "..", "bob", "secret.txt");
    expect(() => guard.ensureAllowed(escape, "read")).toThrow(BlockedActionError);
  });

  it("BLOCKS symlink escapes (symlink inside tenant dir pointing to sibling)", () => {
    const link = join(tenantDir, "escape");
    symlinkSync(join(otherTenantDir, "secret.txt"), link);
    expect(() => guard.ensureAllowed(link, "read")).toThrow(BlockedActionError);
  });

  it("BLOCKS reads of the tenant's own SQLite (daemora.db) — protected at all times", () => {
    const db = join(tenantDir, "daemora.db");
    writeFileSync(db, "");
    expect(() => guard.ensureAllowed(db, "read")).toThrow(BlockedActionError);
    expect(() => guard.ensureAllowed(db, "write")).toThrow(BlockedActionError);
  });

  it("ALLOWS writes to wiki/, projects/, outputs/ inside tenant dir", () => {
    expect(() =>
      guard.ensureAllowed(join(tenantDir, "wiki", "people", "alice.md"), "write"),
    ).not.toThrow();
    expect(() =>
      guard.ensureAllowed(join(tenantDir, "projects", "campaign", "logo.png"), "write"),
    ).not.toThrow();
    expect(() =>
      guard.ensureAllowed(join(tenantDir, "outputs", "report.pdf"), "write"),
    ).not.toThrow();
  });

  it("ensureCommandAllowed rejects shell commands referencing /etc paths", () => {
    expect(() => guard.ensureCommandAllowed("cat /etc/passwd")).toThrow(BlockedActionError);
  });

  it("ensureCommandAllowed rejects shell commands referencing sibling tenant paths", () => {
    expect(() =>
      guard.ensureCommandAllowed(`cat ${otherTenantDir}/secret.txt`),
    ).toThrow(BlockedActionError);
  });

  it("ensureCommandAllowed allows shell commands inside tenant dir", () => {
    expect(() =>
      guard.ensureCommandAllowed(`ls ${tenantDir}/wiki`),
    ).not.toThrow();
  });
});

describe("FilesystemGuard sandbox with extraAllow", () => {
  it("ALLOWS paths listed in extraAllow (e.g. /tmp/work for renders)", () => {
    const root = mkdtempSync(join(tmpdir(), "daemora-mt-extra-"));
    const work = mkdtempSync(join(tmpdir(), "daemora-mt-work-"));
    const guard = new FilesystemGuard({
      mode: "sandbox",
      dataDir: root,
      extraAllow: [work],
    });
    expect(() => guard.ensureAllowed(join(work, "render.png"), "write")).not.toThrow();
    expect(() => guard.ensureAllowed("/etc/passwd", "read")).toThrow(BlockedActionError);
  });
});
