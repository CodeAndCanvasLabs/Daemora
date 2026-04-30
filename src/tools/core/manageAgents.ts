/**
 * manage_agents(action, ...) — inspect and manipulate agent sessions,
 * running sub-agents, and the crew registry.
 *
 * Sub-agent kill/steer requires the SubAgentManager port (Batch H of
 * the JS→TS parity work). Until that lands, those actions return a
 * helpful "not yet available" message so the agent doesn't guess.
 *
 * Actions:
 *   crews             — list available crews (registry)
 *   sessions          — list sessions for the current user
 *   session_get       — last N messages from a session
 *   session_clear     — wipe a session's history
 *   session_clear_all — wipe all sessions
 *   list              — list running sub-agents (pending SubAgentManager port)
 *   kill              — stop a running sub-agent
 *   steer             — send a nudge message to a running sub-agent
 */

import { z } from "zod";

import type { CrewRegistry } from "../../crew/CrewRegistry.js";
import type { SessionStore } from "../../memory/SessionStore.js";
import { NotFoundError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  action: z.enum([
    "crews", "sessions", "session_get", "session_clear", "session_clear_all",
    "list", "kill", "steer",
  ]),
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  message: z.string().optional(),
  count: z.number().int().min(1).max(100).default(10).describe("For session_get."),
});

interface ManageAgentsDeps {
  readonly sessions: SessionStore;
  readonly crews: CrewRegistry;
}

export function makeManageAgentsTool({ sessions, crews }: ManageAgentsDeps): ToolDef<typeof inputSchema, unknown> {
  return {
    name: "manage_agents",
    description:
      "Inspect and manage sessions, sub-agents, and the crew registry. Actions: crews, sessions, session_get, session_clear, session_clear_all, list, kill, steer.",
    category: "agent",
    source: { kind: "core" },
    tags: ["agent", "session", "crew", "sub-agent"],
    inputSchema,
    async execute(input, { logger }) {
      switch (input.action) {
        case "crews": {
          const ids: string[] = [];
          // CrewRegistry uses a private Map — walk via has() against
          // known agents. Instead, use its iteration surface via `size`
          // + get(id) isn't ideal, so we check has() with a bulk list.
          // Prefer the registry's canonical list method if present.
          const reg = crews as unknown as { byId?: Map<string, unknown>; size: number };
          if (reg.byId instanceof Map) {
            for (const id of reg.byId.keys()) ids.push(id);
          }
          return { count: crews.size, ids };
        }

        case "sessions": {
          return sessions.listSessions({ limit: 100 }).map((s) => ({
            id: s.id,
            title: s.title,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            messageCount: s.messageCount,
          }));
        }

        case "session_get": {
          if (!input.sessionId) throw new ValidationError("sessionId is required");
          const session = sessions.getSession(input.sessionId);
          if (!session) throw new NotFoundError(`Session not found: ${input.sessionId}`);
          const history = sessions.getHistory(input.sessionId, { limit: input.count });
          return { id: session.id, title: session.title, messages: history };
        }

        case "session_clear": {
          if (!input.sessionId) throw new ValidationError("sessionId is required");
          const ok = sessions.deleteSession(input.sessionId);
          if (!ok) throw new NotFoundError(`Session not found: ${input.sessionId}`);
          return { id: input.sessionId, cleared: true, message: `Session '${input.sessionId}' cleared` };
        }

        case "session_clear_all": {
          const all = sessions.listSessions({ limit: 10_000 });
          let cleared = 0;
          for (const s of all) {
            if (sessions.deleteSession(s.id)) cleared++;
          }
          return { count: cleared, message: `Cleared ${cleared} sessions` };
        }

        case "list":
        case "kill":
        case "steer": {
          logger.warn("sub-agent action requested but SubAgentManager not ported yet", { action: input.action });
          return {
            action: input.action,
            available: false,
            message:
              "Sub-agent management (list/kill/steer) lands with the SubAgentManager port. " +
              "Use the 'crews' action to list available crew members.",
          };
        }
      }
    },
  };
}
