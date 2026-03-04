import { describe, it, expect, beforeEach } from "vitest";

// Import the singleton scanner
import secretScanner from "../../../src/safety/SecretScanner.js";

describe("SecretScanner", () => {
  describe("scan()", () => {
    it("returns clean result for text with no secrets", () => {
      const result = secretScanner.scan("Hello, this is a normal message.");
      expect(result.found).toBe(false);
      expect(result.secrets).toEqual([]);
      expect(result.redacted).toBe("Hello, this is a normal message.");
    });

    it("returns { found: false } for empty string", () => {
      const result = secretScanner.scan("");
      expect(result.found).toBe(false);
    });

    it("returns { found: false } for null", () => {
      const result = secretScanner.scan(null);
      expect(result.found).toBe(false);
    });

    it("detects AWS Access Key ID", () => {
      const text = "key=AKIAIOSFODNN7EXAMPLE and some extra text";
      const result = secretScanner.scan(text);
      expect(result.found).toBe(true);
      expect(result.secrets.some((s) => s.type === "AWS Access Key")).toBe(true);
      expect(result.redacted).toContain("[REDACTED:AWS Access Key]");
      expect(result.redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    it("detects OpenAI API key pattern", () => {
      const text = "My key is sk-abcdefghijklmnopqrstuvwxyzABCDEF1234";
      const result = secretScanner.scan(text);
      expect(result.found).toBe(true);
      expect(result.secrets.some((s) => s.type === "OpenAI Key")).toBe(true);
      expect(result.redacted).not.toContain("sk-abcdefghijklmnopqrstuvwxyzABCDEF1234");
    });

    it("detects Anthropic API key", () => {
      const text = "using sk-ant-api03-longsecretvalue12345678901234567890abc";
      const result = secretScanner.scan(text);
      expect(result.found).toBe(true);
      expect(result.secrets.some((s) => s.type === "Anthropic Key")).toBe(true);
    });

    it("detects GitHub token", () => {
      const text = "token: ghp_abc123DEF456ghi789JKL012mno345pqrstu";
      const result = secretScanner.scan(text);
      expect(result.found).toBe(true);
      expect(result.secrets.some((s) => s.type === "GitHub Token")).toBe(true);
    });

    it("detects JWT token", () => {
      const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      const result = secretScanner.scan(`Bearer ${jwt}`);
      expect(result.found).toBe(true);
    });

    it("detects database connection string", () => {
      const text = "connecting to postgres://user:password@localhost:5432/mydb";
      const result = secretScanner.scan(text);
      expect(result.found).toBe(true);
      expect(result.secrets.some((s) => s.type === "Connection String")).toBe(true);
      expect(result.redacted).not.toContain("postgres://user:password@localhost:5432/mydb");
    });

    it("detects private key header", () => {
      const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...";
      const result = secretScanner.scan(text);
      expect(result.found).toBe(true);
      expect(result.secrets.some((s) => s.type === "Private Key")).toBe(true);
    });

    it("truncates secret value in findings (shows first 4 + last 4)", () => {
      const text = "key=AKIAIOSFODNN7EXAMPLE";
      const result = secretScanner.scan(text);
      const secret = result.secrets.find((s) => s.type === "AWS Access Key");
      expect(secret.value).toMatch(/^AKIA\.\.\.MPLE$/);
    });

    it("redacts all occurrences of the same secret", () => {
      const key = "AKIAIOSFODNN7EXAMPLE";
      const text = `first: ${key} second: ${key}`;
      const result = secretScanner.scan(text);
      expect(result.redacted).not.toContain(key);
      expect(result.redacted.match(/\[REDACTED:AWS Access Key\]/g)?.length).toBe(2);
    });
  });

  describe("redactOutput()", () => {
    it("returns clean text unchanged", () => {
      const out = secretScanner.redactOutput("normal output text");
      expect(out).toBe("normal output text");
    });

    it("applies pattern-based redaction", () => {
      const out = secretScanner.redactOutput("key=AKIAIOSFODNN7EXAMPLE");
      expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(out).toContain("[REDACTED:AWS Access Key]");
    });
  });

  describe("addKnownSecrets()", () => {
    it("adds short values (< 8 chars) without crashing", () => {
      expect(() => secretScanner.addKnownSecrets(["short", ""])).not.toThrow();
    });
  });

  describe("stats()", () => {
    it("returns totalDetections count", () => {
      const s = secretScanner.stats();
      expect(typeof s.totalDetections).toBe("number");
      expect(s.totalDetections).toBeGreaterThanOrEqual(0);
    });
  });
});
