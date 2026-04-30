/**
 * team(action, ...) — create and inspect multi-worker teams.
 *
 * Covers the main-agent actions from the JS `teamTask`:
 *   create    — spin up a team with a DAG of workers
 *   status    — team + worker statuses, results, errors
 *   list      — every team this instance knows about
 *   disband   — delete a team and its workers
 *   workers   — detail on one team's workers
 *
 * Team Lead / Worker runtime actions (plan approval, worker results)
 * ship with TeamLeadRunner and don't belong in the main-agent tool.
 */

import { z } from "zod";

import type { TeamStore } from "../../teams/TeamStore.js";
import { NotFoundError, ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const workerSchema = z.object({
  name: z.string().min(1).describe("Unique worker name inside this team."),
  task: z.string().min(1).describe("Prompt describing what this worker does."),
  profile: z.string().optional().describe("Sub-agent profile id (if using profiles)."),
  crew: z.string().optional().describe("Crew id (if using crews)."),
  blockedByWorkers: z.array(z.string()).optional()
    .describe("Names of workers that must finish first — the DAG edges."),
});

const inputSchema = z.object({
  action: z.enum(["create", "status", "list", "disband", "workers"]),
  id: z.string().optional(),
  name: z.string().optional().describe("Team name (required for create)."),
  task: z.string().optional().describe("Team-level objective (required for create)."),
  project: z.string().optional(),
  workers: z.array(workerSchema).optional(),
});

export function makeTeamTool(store: TeamStore): ToolDef<typeof inputSchema, unknown> {
  return {
    name: "team",
    description:
      "Create and manage multi-worker teams. Actions: create, status, list, disband, workers.",
    category: "agent",
    source: { kind: "core" },
    tags: ["team", "orchestration", "multi-agent"],
    inputSchema,
    async execute(input, { logger }) {
      switch (input.action) {
        case "create": {
          if (!input.name) throw new ValidationError("name is required");
          if (!input.task) throw new ValidationError("task is required");
          if (!input.workers || input.workers.length === 0) {
            throw new ValidationError("workers must be a non-empty array");
          }
          const team = store.createTeam({
            name: input.name,
            task: input.task,
            ...(input.project ? { project: input.project } : {}),
            workers: input.workers.map((w) => ({
              name: w.name,
              task: w.task,
              ...(w.profile ? { profile: w.profile } : {}),
              ...(w.crew ? { crew: w.crew } : {}),
              ...(w.blockedByWorkers ? { blockedByWorkers: w.blockedByWorkers } : {}),
            })),
          });
          logger.info("team created", { id: team.id, name: team.name, workers: input.workers.length });
          return {
            id: team.id,
            name: team.name,
            workerCount: input.workers.length,
            message: `Team '${team.name}' created (${team.id.slice(0, 8)}) with ${input.workers.length} worker(s)`,
          };
        }

        case "list": {
          return store.listTeams().map((t) => ({
            id: t.id,
            name: t.name,
            status: t.status,
            createdAt: new Date(t.createdAt).toISOString(),
            completedAt: t.completedAt ? new Date(t.completedAt).toISOString() : null,
          }));
        }

        case "status": {
          if (!input.id) throw new ValidationError("id is required");
          const team = store.getTeam(input.id);
          if (!team) throw new NotFoundError(`Team not found: ${input.id}`);
          const workers = store.getWorkers(input.id);
          const byStatus = workers.reduce<Record<string, number>>((acc, w) => {
            acc[w.status] = (acc[w.status] ?? 0) + 1;
            return acc;
          }, {});
          return {
            team: {
              id: team.id,
              name: team.name,
              status: team.status,
              task: team.task,
              createdAt: new Date(team.createdAt).toISOString(),
              completedAt: team.completedAt ? new Date(team.completedAt).toISOString() : null,
            },
            workers: workers.map((w) => ({
              id: w.id,
              name: w.name,
              status: w.status,
              result: w.result,
              error: w.error,
              startedAt: w.startedAt ? new Date(w.startedAt).toISOString() : null,
              completedAt: w.completedAt ? new Date(w.completedAt).toISOString() : null,
            })),
            summary: byStatus,
          };
        }

        case "workers": {
          if (!input.id) throw new ValidationError("id is required");
          const team = store.getTeam(input.id);
          if (!team) throw new NotFoundError(`Team not found: ${input.id}`);
          return store.getWorkers(input.id);
        }

        case "disband": {
          if (!input.id) throw new ValidationError("id is required");
          const team = store.getTeam(input.id);
          if (!team) throw new NotFoundError(`Team not found: ${input.id}`);
          store.deleteTeam(input.id);
          return { id: input.id, disbanded: true, message: `Team '${team.name}' disbanded` };
        }
      }
    },
  };
}
