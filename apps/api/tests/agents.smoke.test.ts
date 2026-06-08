/**
 * Agent roster + plan-tiered limits.
 *
 *  - GET/POST/DELETE /agents require auth
 *  - free/trial plan caps at 1 agent; pro allows several
 *  - a user sees + deletes only their OWN agents
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { buildAgentRoutes } from "../src/routes/agents.js";
import { agents, subscriptions, users } from "../src/db/schema.js";
import type { Auth } from "../src/auth/auth.js";
import { makeTestDb } from "./helpers.js";
import type { DB } from "../src/db/client.js";

/** Mock Better Auth — the test injects the user id as the session cookie. */
function fakeAuth(db: DB): Auth {
  return {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const cookie = headers.get("cookie") ?? headers.get("authorization") ?? "";
        const m = /daemora\.session_token=([^;]+)/.exec(cookie) ?? /^Bearer\s+(.+)$/i.exec(cookie);
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
  const ctx = makeTestDb();
  db = ctx.db;
  app = new Hono();
  app.route("/agents", buildAgentRoutes({ db, auth: fakeAuth(db) }));

  userId = randomUUID();
  await db.insert(users).values({ id: userId, email: "alice@x.com", emailVerified: true });
});

function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}), cookie: `daemora.session_token=${userId}` },
  });
}

const createBody = (name: string, profileId = "coding") =>
  ({ method: "POST", body: JSON.stringify({ name, profileId }) });

describe("agent roster + plan limits", () => {
  it("rejects unauthenticated callers (401)", async () => {
    expect((await app.request("/agents")).status).toBe(401);
  });

  it("free/trial plan caps at 1 agent", async () => {
    await db.insert(subscriptions).values({ userId, plan: "trial", status: "trialing", externalProvider: "contra" });
    expect((await authed("/agents", createBody("Coder", "coding"))).status).toBe(201);
    const r2 = await authed("/agents", createBody("Second", "sales"));
    expect(r2.status).toBe(403);
    expect((await r2.json()).error).toBe("agent_limit_reached");
  });

  it("no subscription → free tier (1 agent)", async () => {
    expect((await authed("/agents", createBody("Only"))).status).toBe(201);
    expect((await authed("/agents", createBody("Extra"))).status).toBe(403);
  });

  it("pro plan allows several agents, then caps", async () => {
    await db.insert(subscriptions).values({ userId, plan: "pro", status: "active", externalProvider: "contra" });
    for (let i = 0; i < 5; i++) {
      expect((await authed("/agents", createBody(`A${i}`))).status).toBe(201);
    }
    expect((await authed("/agents", createBody("A6"))).status).toBe(403);
  });

  it("lists only the user's own agents + their cap", async () => {
    const other = randomUUID();
    await db.insert(users).values({ id: other, email: "bob@x.com", emailVerified: true });
    await db.insert(agents).values({ userId: other, name: "Bob agent", profileId: "coding", status: "active" });
    await db.insert(subscriptions).values({ userId, plan: "pro", status: "active", externalProvider: "contra" });
    await authed("/agents", createBody("Mine"));

    const body = (await (await authed("/agents")).json()) as { agents: { name: string }[]; maxAgents: number };
    expect(body.agents.length).toBe(1);
    expect(body.agents[0]!.name).toBe("Mine");
    expect(body.maxAgents).toBe(5);
  });

  it("can't delete another user's agent (404)", async () => {
    const other = randomUUID();
    await db.insert(users).values({ id: other, email: "bob@x.com", emailVerified: true });
    const inserted = await db
      .insert(agents)
      .values({ userId: other, name: "Bob", profileId: "coding", status: "active" })
      .returning();
    expect((await authed(`/agents/${inserted[0]!.id}`, { method: "DELETE" })).status).toBe(404);
  });
});
