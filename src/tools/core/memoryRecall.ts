/**
 * memory_recall — BM25 search over previously-saved facts.
 *
 * Query is natural language. Results come back oldest-to-newest within
 * the rank band, with the original timestamps so the caller can tell
 * "you told me this a year ago" from "you told me this yesterday".
 */

import { z } from "zod";

import type { MemoryStore } from "../../memory/MemoryStore.js";
import type { ToolDef } from "../types.js";

const inputSchema = z.object({
  query: z.string().min(1).max(400).describe("Natural-language query over saved memory."),
  limit: z.number().int().min(1).max(50).default(5),
  tags_any: z.array(z.string()).optional().describe("At least one of these tags must be present."),
  tags_all: z.array(z.string()).optional().describe("All of these tags must be present."),
});

interface Recalled {
  readonly id: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly createdAt: number;
  readonly rank: number;
}

export function makeMemoryRecallTool(store: MemoryStore): ToolDef<typeof inputSchema, { query: string; results: readonly Recalled[] }> {
  return {
    name: "memory_recall",
    description: "Search saved memories by keyword. Returns the most relevant entries first (BM25 ranking).",
    category: "data",
    source: { kind: "core" },
    alwaysOn: true,
    inputSchema,
    async execute({ query, limit, tags_any, tags_all }) {
      const hits = store.search(query, {
        limit,
        ...(tags_any ? { tagsAny: tags_any } : {}),
        ...(tags_all ? { tagsAll: tags_all } : {}),
      });
      return {
        query,
        results: hits.map((h) => ({
          id: h.id,
          content: h.content,
          tags: h.tags,
          createdAt: h.createdAt,
          rank: h.rank,
        })),
      };
    },
  };
}
