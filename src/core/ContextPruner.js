/**
 * Context Pruner - reduces context size by trimming tool results before LLM compaction.
 *
 * Strategy (run BEFORE model compaction):
 * 1. Estimate token count of messages
 * 2. If under budget → do nothing
 * 3. If over → prune tool results:
 *    - Soft-trim: results > 1000 tokens → keep first 375 + last 375 tokens (~750 kept)
 *    - Hard-clear: results > 12500 tokens → replace with "[Tool result cleared — was N tokens]"
 *    - Protect last 3 assistant responses
 *    - Never prune user messages
 * 4. Return pruned messages (original array mutated in-place for efficiency)
 */

const SOFT_TRIM_THRESHOLD = 1000;     // tokens — trim results larger than this
const SOFT_TRIM_HEAD = 375;           // tokens to keep from start
const SOFT_TRIM_TAIL = 375;           // tokens to keep from end
const HARD_CLEAR_THRESHOLD = 12500;   // tokens — nuke results larger than this
const PROTECT_LAST_ASSISTANTS = 3;
const CHARS_PER_TOKEN = 4;            // rough estimate: 1 token ≈ 4 chars

function toTokens(chars) { return Math.ceil(chars / CHARS_PER_TOKEN); }
function toChars(tokens) { return tokens * CHARS_PER_TOKEN; }

function estimateTokens(text) {
  return Math.ceil((text?.length || 0) / CHARS_PER_TOKEN);
}

function estimateMessageTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    total += estimateTokens(content) + 4; // role overhead
  }
  return total;
}

/**
 * Prune tool results to fit within token budget.
 * Mutates messages in-place. Returns { pruned: boolean, softTrimmed: number, hardCleared: number }
 */
export function pruneContext(messages, tokenBudget) {
  if (!messages || messages.length === 0) return { pruned: false, softTrimmed: 0, hardCleared: 0 };

  const currentTokens = estimateMessageTokens(messages);
  if (currentTokens <= tokenBudget) return { pruned: false, softTrimmed: 0, hardCleared: 0 };

  let softTrimmed = 0;
  let hardCleared = 0;

  // Find last N assistant message indices to protect
  const protectedIndices = new Set();
  let assistantCount = 0;
  for (let i = messages.length - 1; i >= 0 && assistantCount < PROTECT_LAST_ASSISTANTS; i--) {
    if (messages[i].role === "assistant") {
      protectedIndices.add(i);
      assistantCount++;
    }
  }

  // Process messages oldest-first, skip user messages and protected assistants
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") continue;
    if (protectedIndices.has(i)) continue;

    const content = typeof messages[i].content === "string"
      ? messages[i].content
      : JSON.stringify(messages[i].content);

    if (!content) continue;
    const tokenLen = estimateTokens(content);

    // Hard-clear very large results
    if (tokenLen > HARD_CLEAR_THRESHOLD) {
      messages[i].content = `[Tool result cleared — was ${tokenLen.toLocaleString()} tokens]`;
      hardCleared++;
      continue;
    }

    // Soft-trim medium results
    if (tokenLen > SOFT_TRIM_THRESHOLD) {
      const headChars = toChars(SOFT_TRIM_HEAD);
      const tailChars = toChars(SOFT_TRIM_TAIL);
      const head = content.slice(0, headChars);
      const tail = content.slice(-tailChars);
      const trimmedTokens = tokenLen - SOFT_TRIM_HEAD - SOFT_TRIM_TAIL;
      messages[i].content = `${head}\n...[${trimmedTokens.toLocaleString()} tokens trimmed]...\n${tail}`;
      softTrimmed++;
    }

    // Check if we're under budget now
    if (estimateMessageTokens(messages) <= tokenBudget) break;
  }

  const pruned = softTrimmed > 0 || hardCleared > 0;
  if (pruned) {
    console.log(`[ContextPruner] Trimmed context: ${softTrimmed} soft-trimmed, ${hardCleared} hard-cleared`);
  }

  return { pruned, softTrimmed, hardCleared };
}
