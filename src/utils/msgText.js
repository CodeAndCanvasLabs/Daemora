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
