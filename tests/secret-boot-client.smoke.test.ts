/**
 * Tenant secret boot client — fetches BYOK secrets from the gateway broker
 * with the signed identity, holding them in-memory. Fails soft to {}.
 */

import { describe, it, expect } from "vitest";

import { fetchTenantSecrets } from "../src/multitenant/secretBootClient.js";

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = handler(String(input), init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("fetchTenantSecrets", () => {
  it("returns secrets on 200 and sends the identity header to the right URL", async () => {
    let seenHeader: string | null = null;
    const ff = fakeFetch((url, init) => {
      seenHeader = new Headers(init?.headers).get("x-daemora-user");
      expect(url).toBe("http://gw.local/internal/secrets");
      return { status: 200, body: { secrets: { OPENAI_API_KEY: "x" } } };
    });
    const out = await fetchTenantSecrets("http://gw.local/", "tok-123", ff);
    expect(out).toEqual({ OPENAI_API_KEY: "x" });
    expect(seenHeader).toBe("tok-123");
  });

  it("returns {} on a non-2xx response", async () => {
    const ff = fakeFetch(() => ({ status: 401, body: { error: "unauthorized" } }));
    expect(await fetchTenantSecrets("http://gw.local", "tok", ff)).toEqual({});
  });

  it("returns {} when fetch throws (broker unreachable)", async () => {
    const ff = (async () => { throw new Error("boom"); }) as typeof fetch;
    expect(await fetchTenantSecrets("http://gw.local", "tok", ff)).toEqual({});
  });
});
