/**
 * Unified config endpoint (/api/me/config) — central Postgres source of truth.
 *
 *  - GET/PUT/DELETE require auth
 *  - PUT upserts a partial config object; GET returns the merged map
 *  - secrets (KEY/SECRET/TOKEN/…) are rejected — they belong in the vault
 *  - a user only ever sees/saves their OWN config
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { buildConfigRoutes } from "../src/routes/config.js";
import { users, tenants } from "../src/db/schema.js";
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

let db: DB;
let app: Hono;
let userId: string;

beforeEach(async () => {
  db = makeTestDb().db;
  app = new Hono();
  app.route("/api/me", buildConfigRoutes({ db, auth: fakeAuth(db) }));
  userId = randomUUID();
  await db.insert(users).values({ id: userId, email: "alice@x.com", emailVerified: true });
});

function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}), cookie: `daemora.session_token=${userId}` },
  });
}

describe("unified config endpoint", () => {
  it("rejects unauthenticated callers (401)", async () => {
    expect((await app.request("/api/me/config")).status).toBe(401);
  });

  it("starts empty, then PUT upserts and GET returns the merged map", async () => {
    expect((await (await authed("/api/me/config")).json()).config).toEqual({});

    const put = await authed("/api/me/config", {
      method: "PUT",
      body: JSON.stringify({ DEFAULT_MODEL: "vertex:gemini-3.5-flash", MAX_DAILY_COST: 5 }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).config).toEqual({ DEFAULT_MODEL: "vertex:gemini-3.5-flash", MAX_DAILY_COST: 5 });

    const got = (await (await authed("/api/me/config")).json()).config;
    expect(got.DEFAULT_MODEL).toBe("vertex:gemini-3.5-flash");
  });

  it("PUT is a partial upsert — existing keys survive, named keys update", async () => {
    await authed("/api/me/config", { method: "PUT", body: JSON.stringify({ DEFAULT_MODEL: "google:gemini-2.5-flash", AUTH_ENABLED: false }) });
    await authed("/api/me/config", { method: "PUT", body: JSON.stringify({ DEFAULT_MODEL: "vertex:gemini-3.5-flash" }) });
    const got = (await (await authed("/api/me/config")).json()).config;
    expect(got.DEFAULT_MODEL).toBe("vertex:gemini-3.5-flash"); // updated
    expect(got.AUTH_ENABLED).toBe(false);                       // survived
  });

  it("rejects secret-looking keys (they belong in the vault)", async () => {
    const r = await authed("/api/me/config", { method: "PUT", body: JSON.stringify({ OPENAI_API_KEY: "sk-xxx" }) });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("secret_not_allowed");
  });

  it("DELETE removes one key (reset to default)", async () => {
    await authed("/api/me/config", { method: "PUT", body: JSON.stringify({ DEFAULT_MODEL: "vertex:gemini-3.5-flash" }) });
    await authed("/api/me/config/DEFAULT_MODEL", { method: "DELETE" });
    expect((await (await authed("/api/me/config")).json()).config).toEqual({});
  });

  it("a user only sees their own config", async () => {
    await authed("/api/me/config", { method: "PUT", body: JSON.stringify({ DEFAULT_MODEL: "vertex:gemini-3.5-flash" }) });
    const other = randomUUID();
    await db.insert(users).values({ id: other, email: "bob@x.com", emailVerified: true });
    const r = await app.request("/api/me/config", { headers: { cookie: `daemora.session_token=${other}` } });
    expect((await r.json()).config).toEqual({});
  });
});

describe("config live-apply to running tenant", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  afterEach(() => vi.unstubAllGlobals());

  function appWith(upstream: string | undefined): { app: Hono; userId: string; db: DB; ready: Promise<void> } {
    const tdb = makeTestDb().db;
    const uid = randomUUID();
    const ready = (async () => {
      await tdb.insert(users).values({ id: uid, email: "carol@x.com", emailVerified: true });
      await tdb.insert(tenants).values({ userId: uid, slug: "carol-at-x-com", status: "running" });
    })();
    const a = new Hono();
    a.route("/api/me", buildConfigRoutes({
      db: tdb,
      auth: fakeAuth(tdb),
      manager: { getUpstreamUrl: () => upstream },
      signingSecret: "test-secret-aaaaaaaaaaaaaaaaaaaa",
    }));
    return { app: a, userId: uid, db: tdb, ready };
  }

  it("pushes the change to the running tenant's /internal/config (signed)", async () => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { app: a, userId: uid, ready } = appWith("http://127.0.0.1:8101");
    await ready;
    const res = await a.request("/api/me/config", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: `daemora.session_token=${uid}` },
      body: JSON.stringify({ DEFAULT_MODEL: "vertex:gemini-3.5-flash" }),
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8101/internal/config");
    expect((init.headers as Record<string, string>)["x-daemora-user"]).toBeTruthy();
    expect(JSON.parse(init.body as string)).toEqual({ DEFAULT_MODEL: "vertex:gemini-3.5-flash" });
  });

  it("does NOT push when the tenant is not running (no upstream)", async () => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { app: a, userId: uid, ready } = appWith(undefined);
    await ready;
    const res = await a.request("/api/me/config", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: `daemora.session_token=${uid}` },
      body: JSON.stringify({ DEFAULT_MODEL: "vertex:gemini-3.5-flash" }),
    });
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
