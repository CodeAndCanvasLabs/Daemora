/**
 * Gateway→tenant signed identity token.
 *
 * The gateway signs `X-Daemora-User`; the tenant verifies it so only the
 * gateway can address a tenant. Covers sign/verify round-trip, bad signature,
 * tampering, expiry, and malformed input.
 */

import { describe, it, expect } from "vitest";

import { signIdentity, verifyIdentity } from "../src/multitenant/identityToken.js";

const SECRET = "internal-signing-secret-0123456789abcd";

describe("gateway identity token", () => {
  it("signs + verifies a valid token", () => {
    const tok = signIdentity(SECRET, "user-1", "alice-co");
    expect(verifyIdentity(SECRET, tok)).toEqual({ userId: "user-1", slug: "alice-co" });
  });

  it("rejects a wrong secret", () => {
    const tok = signIdentity(SECRET, "user-1", "alice-co");
    expect(verifyIdentity("a-different-secret-0123456789abcdef", tok)).toBeNull();
  });

  it("rejects a tampered slug (forging another tenant)", () => {
    const tok = signIdentity(SECRET, "user-1", "alice-co");
    expect(verifyIdentity(SECRET, tok.replace("alice-co", "victim-co"))).toBeNull();
  });

  it("rejects an expired token", () => {
    const tok = signIdentity(SECRET, "user-1", "alice-co", { nowMs: Date.now() - 120_000 });
    expect(verifyIdentity(SECRET, tok)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyIdentity(SECRET, "garbage")).toBeNull();
    expect(verifyIdentity(SECRET, "a.b.c")).toBeNull();
    expect(verifyIdentity(SECRET, "")).toBeNull();
  });
});
