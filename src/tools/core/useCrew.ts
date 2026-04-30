/**
 * use_crew — delegate a task to a named specialist sub-agent.
 *
 * Blocks until the crew finishes, then returns the crew's final answer
 * plus basic telemetry. Errors from the crew propagate as tool errors
 * so the main agent can decide whether to retry or fail forward.
 */

import { z } from "zod";

import type { CrewAgentRunner } from "../../crew/CrewAgentRunner.js";
import type { CrewRegistry } from "../../crew/CrewRegistry.js";
import { NotFoundError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

interface UseCrewTurnContext {
  /** Model id the parent agent is currently resolved to. Crews inherit unless their manifest overrides. */
  resolvedModel(): string;
}

const inputSchema = z.object({
  crew: z.string().min(1).describe("Crew id. Use the list shown in the system prompt."),
  task: z.string().min(1).max(20_000).describe("Full task description — the crew has no prior context from this conversation."),
  maxSteps: z.number().int().min(1).max(30).optional().describe("Step budget for the crew run. Default 15, max 30. Omit unless the task genuinely needs more — most jobs finish in well under 15."),
});

export function makeUseCrewTool(
  registry: CrewRegistry,
  runner: CrewAgentRunner,
  turn: UseCrewTurnContext,
): ToolDef<typeof inputSchema, {
  crewId: string;
  text: string;
  toolCalls: number;
  steps: number;
  inputTokens: number;
  outputTokens: number;
}> {
  return {
    name: "use_crew",
    description:
      "Delegate a task to a specialist crew. Returns the crew's finished answer. Give a full task description — the crew has no memory of this chat.",
    category: "agent",
    source: { kind: "core" },
    alwaysOn: true,
    inputSchema,
    async execute({ crew, task, maxSteps }, { taskId, abortSignal }) {
      if (!registry.has(crew)) {
        throw new NotFoundError(`Unknown crew: ${crew}`, {
          knownCrews: registry.list().map((c) => c.manifest.id),
        });
      }
      const result = await runner.run({
        crewId: crew,
        task,
        parentTaskId: taskId,
        parentModelId: turn.resolvedModel(),
        ...(maxSteps ? { maxSteps } : {}),
        abortSignal,
      });
      return {
        crewId: result.crewId,
        text: result.text,
        toolCalls: result.toolCalls,
        steps: result.steps,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };
    },
  };
}
