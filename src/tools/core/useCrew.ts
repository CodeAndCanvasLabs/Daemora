/**
 * use_crew — delegate a task to a named specialist sub-agent.
 *
 * The schema is a full delegation contract: the crew sees only what the
 * main agent passes, so every field carries a distinct, non-overlapping
 * piece of the brief. Required fields can't be omitted because crews
 * regularly returned `text:""` when given a one-line task with no goal,
 * constraints, or success criteria.
 *
 * Blocks until the crew finishes, then returns the crew's final answer
 * plus telemetry. Errors propagate as tool errors so the main agent can
 * decide whether to retry or fail forward.
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

const referenceSchema = z.object({
  kind: z.enum(["file", "url", "note"]).describe("Reference type. file = local path, url = web link, note = inline text."),
  value: z.string().min(1).describe("The path, URL, or text content."),
  why: z.string().optional().describe("One-line note on why this reference matters for the task."),
});

const inputSchema = z.object({
  crew: z
    .string()
    .min(1)
    .describe("Crew id. Use the list shown in the system prompt."),
  task: z
    .string()
    .min(1)
    .max(20_000)
    .describe(
      "What to do. The work itself, stated plainly. Can be long. Don't include backstory, constraints, or verification here — those go in their own fields.",
    ),
  context: z
    .string()
    .min(1)
    .max(20_000)
    .describe(
      "Why this matters and what the crew needs to know going in: what the user said, what's already been tried, who the audience is, what the broader project looks like. The backstory the crew can't see.",
    ),
  constraints: z
    .string()
    .min(1)
    .max(10_000)
    .describe(
      "Hard limits and don'ts: deadlines, formats, scope edges, things to avoid, tone restrictions, budget, what must NOT happen.",
    ),
  successCriteria: z
    .string()
    .min(1)
    .max(10_000)
    .describe(
      "What 'done' looks like and how the main agent will verify it. Concrete, checkable signals (file at path X, draft of length Y, answer covering Z). Includes the expected return shape if it matters.",
    ),
  references: z
    .array(referenceSchema)
    .optional()
    .describe(
      "Optional source material the crew should consult: files to read, URLs to study, prior outputs, examples. Omit if there are none.",
    ),
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
      "Delegate a task to a specialist crew. Returns the crew's finished answer. The crew has zero memory of this chat — the fields you pass ARE the contract.",
    category: "agent",
    source: { kind: "core" },
    alwaysOn: true,
    inputSchema,
    async execute({ crew, task, context, constraints, successCriteria, references }, { taskId, abortSignal }) {
      if (!registry.has(crew)) {
        throw new NotFoundError(`Unknown crew: ${crew}`, {
          knownCrews: registry.list().map((c) => c.manifest.id),
        });
      }
      const result = await runner.run({
        crewId: crew,
        task,
        context,
        constraints,
        successCriteria,
        ...(references && references.length > 0 ? { references } : {}),
        parentTaskId: taskId,
        parentModelId: turn.resolvedModel(),
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
