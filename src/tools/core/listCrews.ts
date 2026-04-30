/**
 * list_crews — read-only inventory of registered crews.
 *
 * Both the main agent and the planner crew use this to know what
 * delegation targets exist right now. The main agent already has a
 * crew summary block injected into its system prompt at startup, but
 * (a) the prompt cache can drift after register/unregister, and (b)
 * delegated crews (planner included) don't receive the registry
 * inventory in their prompts — they see only their own systemPrompt
 * plus the task. This tool gives them an authoritative live view.
 *
 * Returns each crew's id, name, description, the tool names it can
 * call, and the skills it specialises in. No write capability.
 */

import { z } from "zod";

import type { CrewRegistry } from "../../crew/CrewRegistry.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  crew: z.string().min(1).optional()
    .describe("Optional crew id. When supplied, returns details for that crew only; otherwise returns the full list."),
});

interface CrewInventoryEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly tools: readonly string[];
  readonly droppedTools: readonly string[];
  readonly skills: readonly string[];
  readonly model: string | null;
  readonly temperature: number;
}

export function makeListCrewsTool(registry: CrewRegistry): ToolDef<typeof inputSchema, {
  total: number;
  crews: readonly CrewInventoryEntry[];
}> {
  return {
    name: "list_crews",
    description:
      "Read-only inventory of every crew the main agent can delegate to via use_crew. " +
      "Pass `crew` to get one entry; omit for the full list. Use to ground plans / pick the right delegation target.",
    category: "agent",
    source: { kind: "core" },
    alwaysOn: true,
    tags: ["agent", "discovery", "inventory"],
    inputSchema,
    async execute({ crew }) {
      const all = registry.list();
      const filtered = crew
        ? all.filter((c) => c.manifest.id === crew)
        : all;
      const crews: CrewInventoryEntry[] = filtered.map((c) => ({
        id: c.manifest.id,
        name: c.manifest.name,
        description: c.manifest.description,
        version: c.manifest.version,
        tools: c.resolvedTools,
        droppedTools: c.droppedTools,
        skills: c.manifest.skills,
        model: c.manifest.profile.model ?? null,
        temperature: c.manifest.profile.temperature,
      }));
      return { total: crews.length, crews };
    },
  };
}
