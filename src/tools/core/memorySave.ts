/**
 * memory_save — commit a durable fact the agent should remember across turns.
 *
 * When to call:
 *   - User tells you a stable fact about themselves, their work, or
 *     their preferences ("I use pnpm", "my daughter's name is Luna").
 *   - User asks you to remember something explicitly.
 *   - Mid-task discoveries worth keeping ("API v2 requires x-session
 *     header even though the docs don't mention it").
 *
 * When NOT to call:
 *   - Ephemeral task state — that's conversation history (auto-saved).
 *   - Things already obvious from the code.
 */

import { z } from "zod";

import type { MemoryStore } from "../../memory/MemoryStore.js";
import { ValidationError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  content: z.string().min(1).max(4_000).describe("The fact or preference to remember, in one or two sentences."),
  tags: z.array(z.string().min(1).max(64)).max(16).optional().describe("Lowercase tags for filtering, e.g. ['preference','tooling']."),
});

export function makeMemorySaveTool(store: MemoryStore): ToolDef<typeof inputSchema, { id: string; createdAt: number }> {
  return {
    name: "memory_save",
    description: "Remember a durable fact across conversations. Use sparingly — only things worth keeping.",
    category: "data",
    source: { kind: "core" },
    alwaysOn: true,
    inputSchema,
    async execute({ content, tags }) {
      const trimmed = content.trim();
      if (!trimmed) throw new ValidationError("memory_save: content cannot be empty");
      const entry = store.save({
        content: trimmed,
        ...(tags ? { tags: tags.map((t) => t.toLowerCase()) } : {}),
      });
      return { id: entry.id, createdAt: entry.createdAt };
    },
  };
}
