/**
 * Gateway authenticated tenant resolution — the security closure.
 *
 * Proves a caller can ONLY ever reach their own tenant: resolution is driven
 * by the authenticated session → that user's tenant row, with NO client-
 * supplied slug. Unauthenticated or tenant-less → null.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { resolveAuthedTenant } from "../src/gateway/resolve.js";
import { tenants, users } from "../src/db/schema.js";
import type { Auth } from "../src/auth/auth.js";
import { makeTestDb } from "./helpers.js";
import type { DB } from "../src/db/client.js";

function fakeAuth(db: DB): Auth {
  return {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const cookie = headers.get("cookie") ?? "";
        const m = /daemora\.session_token=([^;]+)/.exec(cookie);
        if (!m?.[1]) return null;
        const rows = await db.select().from(users).where(eq(users.id, decodeURIComponent(m[1]))).limit(1);
        const u = rows[0];
        return u ? { user: u } : null;
      },
    },
  } as unknown as Auth;
}

function headersFor(userId?: string): Headers {
  return new Headers(userId ? { cookie: `daemora.session_token=${userId}` } : {});
}

let db: DB;
let deps: { db: DB; auth: Auth };

beforeEach(() => {
  const ctx = makeTestDb();
  db = ctx.db;
  deps = { db, auth: fakeAuth(db) };
});

describe("resolveAuthedTenant (gateway security closure)", () => {
  it("returns null when unauthenticated", async () => {
    expect(await resolveAuthedTenant(deps, headersFor())).toBeNull();
  });

  it("returns null for an authed user with no tenant yet", async () => {
    const u = randomUUID();
    await db.insert(users).values({ id: u, email: "a@x.com", emailVerified: true });
    expect(await resolveAuthedTenant(deps, headersFor(u))).toBeNull();
  });

  it("resolves the authenticated user's OWN tenant", async () => {
    const u = randomUUID();
    await db.insert(users).values({ id: u, email: "a@x.com", emailVerified: true });
    await db.insert(tenants).values({ userId: u, slug: "alice-co", status: "running" });
    const r = await resolveAuthedTenant(deps, headersFor(u));
    expect(r).toMatchObject({ userId: u, slug: "alice-co", status: "running" });
  });

  it("can NEVER resolve another user's tenant (isolation)", async () => {
    const a = randomUUID();
    const b = randomUUID();
    await db.insert(users).values([
      { id: a, email: "a@x.com", emailVerified: true },
      { id: b, email: "b@x.com", emailVerified: true },
    ]);
    await db.insert(tenants).values([
      { userId: a, slug: "alice-co", status: "running" },
      { userId: b, slug: "bob-co", status: "running" },
    ]);
    // Each session only ever resolves its own tenant.
    expect((await resolveAuthedTenant(deps, headersFor(a)))?.slug).toBe("alice-co");
    expect((await resolveAuthedTenant(deps, headersFor(b)))?.slug).toBe("bob-co");
  });
});
