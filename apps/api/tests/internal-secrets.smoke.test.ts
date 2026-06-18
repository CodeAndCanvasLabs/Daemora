/**
 * Secret broker — GET /internal/secrets.
 *
 * Auth is the gateway's signed identity ONLY. Covers: broker disabled,
 * missing/forged/wrong-secret identity → rejected; valid identity → the
 * tenant's secrets. The decrypt path is faked (it needs the real manager).
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";

import { buildInternalRoutes } from "../src/routes/internal.js";
import { signIdentity } from "../../../src/multitenant/identityToken.js";

const SECRET = "internal-signing-secret-0123456789abcd";
const fakeManager = { getDecryptedSecrets: (slug: string) => ({ OPENAI_API_KEY: `key-for-${slug}` }) };

function appWith(signingSecret?: string): Hono {
  const h = new Hono();
  h.route("/internal", buildInternalRoutes({ manager: fakeManager, ...(signingSecret ? { signingSecret } : {}) }));
  return h;
}

describe("/internal/secrets broker", () => {
  it("503 when the broker is disabled (no signing secret)", async () => {
    expect((await appWith().request("/internal/secrets")).status).toBe(503);
  });

  it("401 without an identity header", async () => {
    expect((await appWith(SECRET).request("/internal/secrets")).status).toBe(401);
  });

  it("401 with a forged/garbage identity", async () => {
    const r = await appWith(SECRET).request("/internal/secrets", { headers: { "x-daemora-user": "garbage" } });
    expect(r.status).toBe(401);
  });

  it("401 when the identity is signed with a different secret", async () => {
    const tok = signIdentity("a-different-secret-0123456789abcdef", "user-1", "alice-co");
    const r = await appWith(SECRET).request("/internal/secrets", { headers: { "x-daemora-user": tok } });
    expect(r.status).toBe(401);
  });

  it("200 + the tenant's secrets with a valid signed identity", async () => {
    const tok = signIdentity(SECRET, "user-1", "alice-co");
    const r = await appWith(SECRET).request("/internal/secrets", { headers: { "x-daemora-user": tok } });
    expect(r.status).toBe(200);
    expect((await r.json()).secrets).toEqual({ OPENAI_API_KEY: "key-for-alice-co" });
  });
});
