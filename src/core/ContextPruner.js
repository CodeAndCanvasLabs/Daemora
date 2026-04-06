/**
 * Context Pruner - reduces context size by trimming tool results before LLM compaction.
 *
 * Strategy (run BEFORE model compaction):
 * 1. Estimate token count of messages
 * 2. If under budget → do nothing
 * 3. If over → prune tool results:
 *    - Soft-trim: results > 4000 chars → keep first 1500 + "\n...\n" + last 1500
 *    - Hard-clear: results > 50KB → replace with "[Tool result cleared — was N chars]"
 *    - Protect last 3 assistant responses
 *    - Never prune user messages
 * 4. Return pruned messages (original array mutated in-place for efficiency)
 */

const SOFT_TRIM_THRESHOLD = 4000;      // chars
const SOFT_TRIM_HEAD = 1500;           // chars to keep from start
const SOFT_TRIM_TAIL = 1500;           // chars to keep from end
const HARD_CLEAR_THRESHOLD = 50_000;   // 50KB
const PROTECT_LAST_ASSISTANTS = 3;

// Rough token estimate: 1 token ≈ 4 chars
function estimateTokens(text) {
  return Math.ceil((text?.length || 0) / 4);
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
    const len = content.length;

    // Hard-clear very large results
    if (len > HARD_CLEAR_THRESHOLD) {
      messages[i].content = `[Tool result cleared — was ${len.toLocaleString()} chars]`;
      hardCleared++;
      continue;
    }

    // Soft-trim medium results
    if (len > SOFT_TRIM_THRESHOLD) {
      const head = content.slice(0, SOFT_TRIM_HEAD);
      const tail = content.slice(-SOFT_TRIM_TAIL);
      messages[i].content = `${head}\n...[${(len - SOFT_TRIM_HEAD - SOFT_TRIM_TAIL).toLocaleString()} chars trimmed]...\n${tail}`;
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
