/**
 * session_search — find relevant past conversations by keyword, then
 * summarize the top sessions with a cheap model. Hermes pattern.
 *
 * Flow:
 *   1. FTS5 bm25 keyword search across all session_messages.
 *   2. Resolve each hit's session to its root parent (delegation /
 *      compaction chain).
 *   3. Dedupe by root parent, keep top N (default 3) distinct sessions.
 *   4. For each, load the full conversation, window text around the
 *      query matches, and ask the cheap model for a focused summary.
 *   5. Run summaries in parallel with a concurrency semaphore.
 *   6. Return structured results.
 *
 * Fallback: empty query returns recent session metadata (no LLM calls).
 */

import { generateText } from "ai";
import { z } from "zod";

import type { ModelRouter } from "../../models/ModelRouter.js";
import type { SessionStore } from "../../memory/SessionStore.js";
import { createLogger } from "../../util/logger.js";
import { msgText } from "../../util/msgText.js";
import type { ToolDef } from "../types.js";

const log = createLogger("tools.session_search");

const inputSchema = z.object({
  query: z.string().max(500).describe(
    "Keywords for FTS5 search across past conversations. Empty string returns recent sessions.",
  ),
  limit: z.number().int().min(1).max(10).default(3),
});

type SessionSearchResult = {
  success: true;
  query: string;
  results: readonly {
    session_id: string;
    title: string;
    started_at: number;
    match_count: number;
    summary: string;
  }[];
} | {
  success: true;
  mode: "recent";
  sessions: readonly { id: string; title: string; started_at: number; message_count: number }[];
} | {
  success: false;
  error: string;
};

const MAX_CONVERSATION_CHARS = 12_000;
const CONCURRENCY = 3;

export interface SessionSearchDeps {
  readonly sessions: SessionStore;
  readonly models: ModelRouter;
  /** Called-on session ID so the current conversation is excluded. */
  readonly currentSessionId?: string;
}

export function makeSessionSearchTool(
  deps: SessionSearchDeps,
): ToolDef<typeof inputSchema, SessionSearchResult> {
  return {
    name: "session_search",
    description:
      "Search past conversations for relevant context. Use when the user references a previous " +
      "task, decision, or fact. Returns focused summaries of matching sessions — not raw transcripts.",
    category: "data",
    source: { kind: "core" },
    alwaysOn: true,
    inputSchema,
    async execute({ query, limit }) {
      const q = query.trim();
      if (!q) return listRecent(deps, limit);

      const hits = deps.sessions.searchMessages(q, { limit: 50 });
      if (hits.length === 0) {
        return { success: true, query: q, results: [] };
      }

      const byRoot = new Map<string, { matches: number; firstSeq: number }>();
      for (const h of hits) {
        const root = deps.sessions.resolveToParent(h.sessionId);
        if (deps.currentSessionId && root === deps.currentSessionId) continue;
        const prev = byRoot.get(root);
        if (prev) {
          prev.matches += 1;
        } else {
          byRoot.set(root, { matches: 1, firstSeq: h.seq });
        }
        if (byRoot.size >= Math.max(limit * 3, 6)) break;
      }

      const ranked = [...byRoot.entries()]
        .sort((a, b) => b[1].matches - a[1].matches)
        .slice(0, limit);

      if (ranked.length === 0) {
        return { success: true, query: q, results: [] };
      }

      const cheap = await deps.models.getCheap().catch((e) => {
        log.warn({ err: (e as Error).message }, "cheap model unavailable for summarization");
        return null;
      });

      const results = await runWithConcurrency(
        ranked.map(([sessionId, info]) => async () => {
          const session = deps.sessions.getSession(sessionId);
          const messages = deps.sessions.getMessagesAsConversation(sessionId);
          const transcript = formatTranscript(messages, q);
          const summary = cheap
            ? await summariseSession(cheap.model, transcript, q, session?.title ?? "")
                .catch((e) => `(summary failed: ${(e as Error).message})`)
            : transcript.slice(0, 2000);
          return {
            session_id: sessionId,
            title: session?.title ?? "(untitled)",
            started_at: session?.createdAt ?? 0,
            match_count: info.matches,
            summary,
          };
        }),
        CONCURRENCY,
      );

      return { success: true, query: q, results };
    },
  };
}

function listRecent(deps: SessionSearchDeps, limit: number): SessionSearchResult {
  const sessions = deps.sessions.listSessions({ limit });
  return {
    success: true,
    mode: "recent",
    sessions: sessions.map((s) => ({
      id: s.id, title: s.title, started_at: s.createdAt, message_count: s.messageCount,
    })),
  };
}

function formatTranscript(
  messages: readonly { role: string; content: unknown }[],
  query: string,
): string {
  const rendered = messages
    .map((m) => `[${m.role}] ${msgText(m.content as never)}`.slice(0, 1500))
    .join("\n---\n");
  if (rendered.length <= MAX_CONVERSATION_CHARS) return rendered;

  // Windowed around the query matches — keep 60% head around first hit
  // and 40% tail around last hit.
  const q = query.toLowerCase();
  const first = rendered.toLowerCase().indexOf(q);
  if (first < 0) return rendered.slice(0, MAX_CONVERSATION_CHARS) + "\n…[truncated]";
  const windowStart = Math.max(0, first - Math.floor(MAX_CONVERSATION_CHARS * 0.3));
  return rendered.slice(windowStart, windowStart + MAX_CONVERSATION_CHARS) + "\n…[truncated]";
}

async function summariseSession(
  model: Parameters<typeof generateText>[0]["model"],
  transcript: string,
  query: string,
  title: string,
): Promise<string> {
  const system = [
    "You are reviewing a past conversation transcript. Summarise with focus on the SEARCH TOPIC.",
    "Include: what the user wanted, actions taken, outcomes, key decisions, specific paths / commands,",
    "and anything left unresolved. Be thorough but concise. Preserve technical details.",
  ].join(" ");
  const prompt = [
    `Search topic: ${query}`,
    `Session title: ${title}`,
    "",
    "TRANSCRIPT:",
    transcript,
    "",
    `Summarise with focus on: ${query}`,
  ].join("\n");
  const { text } = await generateText({
    model,
    system,
    prompt,
    temperature: 0.1,
  });
  return text.trim();
}

async function runWithConcurrency<T>(
  fns: readonly (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const out: T[] = new Array(fns.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, fns.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= fns.length) return;
      const fn = fns[idx];
      if (fn) out[idx] = await fn();
    }
  });
  await Promise.all(workers);
  return out;
}
