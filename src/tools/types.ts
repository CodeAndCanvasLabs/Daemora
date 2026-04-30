/**
 * Tool — a callable an agent can invoke from the model's tool-use loop.
 *
 * Wrapper around AI SDK's `tool()` so we add structured metadata
 * (category, source, tags) for filtering + discovery without ever
 * shipping these to the model.
 */

import { tool, type Tool as AiTool } from "ai";
import type { z, ZodType } from "zod";

export type ToolCategory =
  | "core"
  | "filesystem"
  | "shell"
  | "network"
  | "browser"
  | "search"
  | "ai"
  | "channel"
  | "media"
  | "data"
  | "system"
  | "agent";

export interface ToolDef<TIn extends ZodType = ZodType, TOut = unknown> {
  /** Stable name. The agent calls the tool by this. */
  readonly name: string;
  /** One-line description shown to the model. Keep under 140 chars. */
  readonly description: string;
  /** Zod schema for inputs. Auto-validated before execute(). */
  readonly inputSchema: TIn;
  /** Implementation. Receives parsed/validated input + abort signal. */
  readonly execute: (input: z.infer<TIn>, ctx: ToolContext) => Promise<TOut>;
  /** Bucketing for discovery. */
  readonly category: ToolCategory;
  /** Where this tool came from. Lets us drop integration tools when an integration is disabled. */
  readonly source: { kind: "core" } | { kind: "integration"; id: string } | { kind: "crew"; id: string };
  /** Free-form discovery keywords. Used by `discoverTools(query)`. */
  readonly tags?: readonly string[];
  /** If true, this tool is always sent to the model even when not skill-matched. */
  readonly alwaysOn?: boolean;
  /** If true, mutates state — caller may require explicit user confirmation. */
  readonly destructive?: boolean;
}

export interface ToolContext {
  readonly abortSignal: AbortSignal;
  readonly taskId: string;
  readonly logger: { info: (msg: string, ctx?: object) => void; warn: (msg: string, ctx?: object) => void; error: (msg: string, ctx?: object) => void };
}

/** Convert our ToolDef → AI SDK Tool, baking in the abort signal. */
export function toAiTool(def: ToolDef, ctxFactory: (signal: AbortSignal) => ToolContext): AiTool {
  return tool({
    description: def.description,
    inputSchema: def.inputSchema,
    execute: async (input, { abortSignal }) => {
      const ctx = ctxFactory(abortSignal ?? new AbortController().signal);
      return def.execute(input, ctx);
    },
  });
}
