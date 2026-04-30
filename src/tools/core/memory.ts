/**
 * memory — hermes-pattern declarative memory tool.
 *
 * Two targets:
 *   - target="user"   → USER.md, facts about the user (persona, prefs)
 *   - target="memory" → MEMORY.md, notes about environment / project
 *
 * Three actions:
 *   - add(target, content)
 *   - replace(target, old_text, content)
 *   - remove(target, old_text)
 *
 * System-prompt injection is frozen at session start — mid-session writes
 * DO hit disk, but the model sees the same snapshot for the whole
 * session. Fresh snapshots only on reload/compaction.
 */

import { z } from "zod";

import type { EventBus } from "../../events/eventBus.js";
import type {
  DeclarativeMemoryStore,
  MemoryTarget,
} from "../../memory/DeclarativeMemoryStore.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  action: z.enum(["add", "replace", "remove"]),
  target: z.enum(["user", "memory"]),
  content: z.string().max(2000).optional(),
  old_text: z.string().max(2000).optional(),
});

type MemoryToolResult =
  | { success: true; message: string; entry_count?: number; chars?: number; limit?: number }
  | { success: false; error: string };

export function makeMemoryTool(
  store: DeclarativeMemoryStore,
  bus?: EventBus,
): ToolDef<typeof inputSchema, MemoryToolResult> {
  return {
    name: "memory",
    description:
      "Save or update persistent declarative memory. target='user' holds facts about the user " +
      "(preferences, persona, recurring corrections); target='memory' holds notes about the " +
      "environment/project. Save DECLARATIVE FACTS, not imperative instructions " +
      "('User prefers concise responses' ✓ — 'Always respond concisely' ✗). " +
      "DO NOT save task progress or completed-work logs — that's session history, not memory.",
    category: "data",
    source: { kind: "core" },
    alwaysOn: true,
    inputSchema,
    async execute(input) {
      const target = input.target as MemoryTarget;
      try {
        let r;
        if (input.action === "add") {
          if (!input.content) return { success: false, error: "content is required for add" };
          r = await store.add(target, input.content);
        } else if (input.action === "replace") {
          if (!input.old_text || !input.content) {
            return { success: false, error: "old_text and content are required for replace" };
          }
          r = await store.replace(target, input.old_text, input.content);
        } else if (input.action === "remove") {
          if (!input.old_text) return { success: false, error: "old_text is required for remove" };
          r = await store.remove(target, input.old_text);
        } else {
          return { success: false, error: `unknown action: ${String(input.action)}` };
        }
        if (r.success) bus?.emit("memory:written", { target, action: input.action });
        return toResult(r);
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    },
  };
}

function toResult(r: {
  success: boolean; message: string; entryCount?: number; chars?: number; limit?: number;
}): MemoryToolResult {
  if (!r.success) return { success: false, error: r.message };
  return {
    success: true,
    message: r.message,
    ...(r.entryCount !== undefined ? { entry_count: r.entryCount } : {}),
    ...(r.chars !== undefined ? { chars: r.chars } : {}),
    ...(r.limit !== undefined ? { limit: r.limit } : {}),
  };
}
