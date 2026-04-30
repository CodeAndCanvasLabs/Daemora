/**
 * parallel_crew — fan out N independent tasks to different crews at once.
 *
 * Use when two (or more) tasks have no ordering dependency — e.g. "have
 * the researcher find X while the reviewer checks Y". Returns one
 * result per task, in the same order, with `ok:false` + error for any
 * that failed without tearing down the siblings.
 */

import { z } from "zod";

import type { CrewAgentRunner } from "../../crew/CrewAgentRunner.js";
import type { CrewRegistry } from "../../crew/CrewRegistry.js";
import { toDaemoraError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

interface UseCrewTurnContext {
  resolvedModel(): string;
}

const taskSchema = z.object({
  crew: z.string().min(1),
  task: z.string().min(1).max(20_000),
});

const inputSchema = z.object({
  tasks: z.array(taskSchema).min(1).max(6).describe("Independent tasks to run in parallel. Max 6."),
  maxSteps: z.number().int().min(1).max(30).optional().describe("Per-crew step budget. Default 15, max 30. Applies to every task in the batch. Omit unless tasks genuinely need more."),
});

interface TaskOutcome {
  readonly crewId: string;
  readonly ok: boolean;
  readonly text?: string;
  readonly error?: { code: string; message: string };
}

export function makeParallelCrewTool(
  registry: CrewRegistry,
  runner: CrewAgentRunner,
  turn: UseCrewTurnContext,
): ToolDef<typeof inputSchema, { results: readonly TaskOutcome[] }> {
  return {
    name: "parallel_crew",
    description:
      "Run multiple independent crew tasks in parallel. Returns results in order. One task's failure doesn't affect the others.",
    category: "agent",
    source: { kind: "core" },
    alwaysOn: true,
    inputSchema,
    async execute({ tasks, maxSteps }, { taskId, abortSignal }) {
      const settled = await Promise.all(
        tasks.map(async (t): Promise<TaskOutcome> => {
          if (!registry.has(t.crew)) {
            return {
              crewId: t.crew,
              ok: false,
              error: { code: "not_found", message: `Unknown crew: ${t.crew}` },
            };
          }
          try {
            const r = await runner.run({
              crewId: t.crew,
              task: t.task,
              parentTaskId: taskId,
              parentModelId: turn.resolvedModel(),
              ...(maxSteps ? { maxSteps } : {}),
              abortSignal,
            });
            return { crewId: r.crewId, ok: true, text: r.text };
          } catch (e) {
            const err = toDaemoraError(e);
            return {
              crewId: t.crew,
              ok: false,
              error: { code: err.code, message: err.message },
            };
          }
        }),
      );
      return { results: settled };
    },
  };
}
