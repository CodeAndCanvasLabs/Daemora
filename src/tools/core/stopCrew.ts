/**
 * stop_crew — abort an in-flight crew run.
 *
 * Use when a delegated crew is stuck, looping, or working on the wrong
 * thing and the main agent wants to abandon it without aborting its own
 * task. Pass a `crewId` to stop just that crew; omit to stop every
 * in-flight crew run.
 *
 * Returns the count of runs aborted. The aborted run's promise rejects
 * with an AbortError, which surfaces as a tool error to the parent so
 * it can decide whether to re-spawn with a corrected contract.
 */

import { z } from "zod";

import type { CrewAgentRunner } from "../../crew/CrewAgentRunner.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  crewId: z
    .string()
    .optional()
    .describe("Crew id to stop. Omit to stop every in-flight crew run."),
});

export function makeStopCrewTool(
  runner: CrewAgentRunner,
): ToolDef<typeof inputSchema, { stopped: number; active: string[] }> {
  return {
    name: "stop_crew",
    description:
      "Abort an in-flight crew run. Pass `crewId` to stop one; omit to stop all. Returns the count of runs aborted plus the list of crews still active.",
    category: "agent",
    source: { kind: "core" },
    inputSchema,
    async execute({ crewId }) {
      const stopped = crewId ? runner.stop(crewId) : runner.stopAll();
      return { stopped, active: runner.listActive() };
    },
  };
}
