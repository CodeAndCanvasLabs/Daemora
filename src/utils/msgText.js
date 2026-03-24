/**
 * Extract plain text from any message content format.
 *
 * Vercel AI SDK returns content in multiple formats:
 *   - string: "hello"
 *   - array:  [{ type: "text", text: "hello" }, { type: "tool-call", ... }]
 *   - object: { type: "text", text: "hello" }
 *
 * This normalizes all of them to a plain string.
 *
 * @param {string|Array|object} content - Message content in any SDK format
 * @returns {string} Plain text content (empty string if no text found)
 */
export function msgText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(p => p.type === "text")
      .map(p => p.text)
      .join("");
  }
  if (content && typeof content === "object" && content.type === "text") {
    return content.text || "";
  }
  return "";
}

/**
 * Compact messages for session storage.
 *
 * Keeps full conversation structure (including tool calls/results) so the
 * model retains context on subsequent turns. Truncates large tool outputs
 * to keep session files small.
 *
 * @param {Array} messages - Raw messages from AgentLoop (SDK format)
 * @param {number} maxToolOutput - Max chars per tool result (default 500)
 * @returns {Array} Messages safe for session storage
 */
export function compactForSession(messages, maxToolOutput = 500) {
  return messages.map(msg => {
    // Tool result messages - truncate large outputs
    if (msg.role === "tool" && Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map(p => {
          if (p.type === "tool-result" && typeof p.result === "string" && p.result.length > maxToolOutput) {
            return { ...p, result: p.result.slice(0, maxToolOutput) + `\n[…truncated ${p.result.length - maxToolOutput} chars]` };
          }
          return p;
        }),
      };
    }
    // String tool results (older format)
    if (msg.role === "tool" && typeof msg.content === "string" && msg.content.length > maxToolOutput) {
      return { ...msg, content: msg.content.slice(0, maxToolOutput) + `\n[…truncated ${msg.content.length - maxToolOutput} chars]` };
    }
    return msg;
  });
}
