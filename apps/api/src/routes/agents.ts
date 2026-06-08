/**
 * /agents — the user's agent roster (multi-agent workforce).
 *
 *   GET    /agents       list the authed user's agents + their plan cap
 *   POST   /agents       create an agent (enforces the plan's agent limit)
 *   DELETE /agents/:id   remove one of the user's own agents
 *
 * The roster is the durable account-level record (central Postgres). Each
 * agent binds to a profile; the per-tenant runtime reads the roster and runs
 * the agents concurrently inside one instance (see profile-per-session).
 */

import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Auth } from "../auth/auth.js";
import type { DB } from "../db/client.js";
import { agents, subscriptions, type User } from "../db/schema.js";
import { maxAgentsForPlan } from "../lib/plans.js";

export interface AgentRoutesDeps {
  readonly db: DB;
  readonly auth: Auth;
}

const createSchema = z.object({
  name: z.string().min(1).max(80),
  profileId: z.string().min(1).max(64),
});

export function buildAgentRoutes(deps: AgentRoutesDeps): Hono {
  const app = new Hono();

  // GET /agents — the user's roster + their plan cap.
  app.get("/", async (c) => {
    const user = await requireUser(c, deps);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const rows = await deps.db.select().from(agents).where(eq(agents.userId, user.id));
    return c.json({ agents: rows, maxAgents: await maxAgentsForUser(deps, user.id) });
  });

  // POST /agents — create, enforcing the plan's agent limit.
  app.post("/", async (c) => {
    const user = await requireUser(c, deps);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);

    const max = await maxAgentsForUser(deps, user.id);
    const active = await deps.db
      .select()
      .from(agents)
      .where(and(eq(agents.userId, user.id), eq(agents.status, "active")));
    if (active.length >= max) {
      return c.json(
        { error: "agent_limit_reached", detail: `Your plan allows ${max} agent(s). Upgrade to run more.`, max },
        403,
      );
    }

    const inserted = await deps.db
      .insert(agents)
      .values({ userId: user.id, name: parsed.data.name, profileId: parsed.data.profileId, status: "active" })
      .returning();
    return c.json({ agent: inserted[0] }, 201);
  });

  // DELETE /agents/:id — remove one of the user's own agents.
  app.delete("/:id", async (c) => {
    const user = await requireUser(c, deps);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const id = c.req.param("id");
    const deleted = await deps.db
      .delete(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, user.id)))
      .returning();
    if (deleted.length === 0) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}

/** The user's current plan → agent cap. No subscription → free tier (1). */
async function maxAgentsForUser(deps: AgentRoutesDeps, userId: string): Promise<number> {
  const rows = await deps.db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1);
  return maxAgentsForPlan(rows[0]?.plan);
}

/** Resolve the authed user via Better Auth (delegates the whole cookie story). */
async function requireUser(c: Context, deps: AgentRoutesDeps): Promise<User | null> {
  const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
  return (session?.user ?? null) as User | null;
}
