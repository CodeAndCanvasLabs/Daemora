import { describe, it, expect } from "vitest";
import { resolve } from "path";
import filesystemGuard from "../../../src/safety/FilesystemGuard.js";

// Note: filesystemGuard is a singleton; stats accumulate across tests.
// We test behavior, not absolute counts.

describe("FilesystemGuard", () => {
  describe("checkRead() - blocked patterns", () => {
    it("blocks .ssh directory access", () => {
      const result = filesystemGuard.checkRead("/home/user/.ssh/id_rsa");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("blocked");
    });

    it("blocks .env file", () => {
      const result = filesystemGuard.checkRead("/app/.env");
      expect(result.allowed).toBe(false);
    });

    it("blocks .env.local variant", () => {
      const result = filesystemGuard.checkRead("/app/.env.local");
      expect(result.allowed).toBe(false);
    });

    it("blocks .env.production variant", () => {
      const result = filesystemGuard.checkRead(".env.production");
      expect(result.allowed).toBe(false);
    });

    it("blocks /etc/shadow", () => {
      const result = filesystemGuard.checkRead("/etc/shadow");
      expect(result.allowed).toBe(false);
    });

    it("blocks .gnupg directory", () => {
      const result = filesystemGuard.checkRead("/home/user/.gnupg/pubring.kbx");
      expect(result.allowed).toBe(false);
    });

    it("blocks .pem files", () => {
      const result = filesystemGuard.checkRead("/certs/server.pem");
      expect(result.allowed).toBe(false);
    });

    it("blocks .key files", () => {
      const result = filesystemGuard.checkRead("/certs/private.key");
      expect(result.allowed).toBe(false);
    });

    it("blocks id_rsa", () => {
      const result = filesystemGuard.checkRead("/root/id_rsa");
      expect(result.allowed).toBe(false);
    });

    it("blocks config/mcp.json", () => {
      const result = filesystemGuard.checkRead(resolve("config/mcp.json"));
      expect(result.allowed).toBe(false);
    });

    it("blocks data/tenants/*.json", () => {
      const result = filesystemGuard.checkRead("/app/data/tenants/telegram_123.json");
      expect(result.allowed).toBe(false);
    });

    it("blocks tenants.json", () => {
      const result = filesystemGuard.checkRead("/app/data/tenants/tenants.json");
      expect(result.allowed).toBe(false);
    });

    it("blocks audit log directory", () => {
      const result = filesystemGuard.checkRead("/app/data/audit/2026-01-01.jsonl");
      expect(result.allowed).toBe(false);
    });

    it("blocks .aws/credentials", () => {
      const result = filesystemGuard.checkRead("/home/user/.aws/credentials");
      expect(result.allowed).toBe(false);
    });

    it("allows a regular file in a safe location", () => {
      const result = filesystemGuard.checkRead("/home/user/Documents/notes.txt");
      expect(result.allowed).toBe(true);
    });

    it("allows a project source file", () => {
      const result = filesystemGuard.checkRead("/projects/myapp/src/index.js");
      expect(result.allowed).toBe(true);
    });

    it("returns { allowed: false } for missing path", () => {
      const result = filesystemGuard.checkRead("");
      expect(result.allowed).toBe(false);
    });

    it("returns { allowed: false } for null path", () => {
      const result = filesystemGuard.checkRead(null);
      expect(result.allowed).toBe(false);
    });
  });

  describe("checkWrite() - blocked patterns", () => {
    it("blocks writing to .env", () => {
      const result = filesystemGuard.checkWrite("/app/.env");
      expect(result.allowed).toBe(false);
    });

    it("blocks writing to /etc/ files", () => {
      const result = filesystemGuard.checkWrite("/etc/hosts");
      expect(result.allowed).toBe(false);
    });

    it("blocks writing to /usr/ files", () => {
      const result = filesystemGuard.checkWrite("/usr/local/bin/evil");
      expect(result.allowed).toBe(false);
    });

    it("blocks writing to /bin/", () => {
      const result = filesystemGuard.checkWrite("/bin/bash");
      expect(result.allowed).toBe(false);
    });

    it("allows writing to a normal project file", () => {
      const result = filesystemGuard.checkWrite("/home/user/projects/app/output.txt");
      expect(result.allowed).toBe(true);
    });
  });

  describe("stats()", () => {
    it("returns blockedCount as a number", () => {
      const s = filesystemGuard.stats();
      expect(typeof s.blockedCount).toBe("number");
      expect(s.blockedCount).toBeGreaterThanOrEqual(0);
    });
  });
});
