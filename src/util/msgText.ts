/**
 * msgText — extract plain text from an AI SDK ModelMessage content.
 *
 * ModelMessage.content can be:
 *   - a plain string (user / assistant text)
 *   - an array of content parts: text, tool_call, tool_result, reasoning,
 *     image, file, etc.
 *
 * For compaction, session search, and token estimation we just want
 * readable text. Tool calls and tool results are JSON-serialised so
 * they still contribute signal but don't break on non-text parts.
 */

import type { ModelMessage } from "ai";

/** Best-effort text extraction from any ModelMessage content. */
export function msgText(content: ModelMessage["content"] | undefined): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  const out: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      out.push(String(part));
      continue;
    }
    const type = (part as { type?: string }).type;
    if (type === "text" || type === "reasoning") {
      const t = (part as { text?: string }).text;
      if (t) out.push(t);
    } else if (type === "tool-call" || type === "tool_call") {
      const name = (part as { toolName?: string; name?: string }).toolName
        ?? (part as { name?: string }).name ?? "tool";
      const input = (part as { input?: unknown; args?: unknown }).input
        ?? (part as { args?: unknown }).args;
      out.push(`[tool:${name}] ${safeJson(input)}`);
    } else if (type === "tool-result" || type === "tool_result") {
      const output = (part as { output?: unknown; result?: unknown }).output
        ?? (part as { result?: unknown }).result;
      out.push(`[tool-result] ${safeJson(output)}`);
    } else {
      out.push(safeJson(part));
    }
  }
  return out.join("\n");
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v) ?? ""; } catch { return String(v); }
}
