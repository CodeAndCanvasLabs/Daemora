import { generateText } from "ai";
import { getCheapModel } from "../models/ModelRouter.js";
import { writeFileSync, mkdirSync } from "fs";
import { config } from "../config/default.js";
import eventBus from "./EventBus.js";

/**
 * Context compaction system.
 *
 * When conversation history approaches the model's context window:
 * 1. Estimate token count
 * 2. If over threshold → summarize older messages
 * 3. Prune verbose tool outputs
 * 4. Persist large outputs to disk
 * 5. Continue with compressed context
 */

/**
 * Rough token estimate: ~4 chars per token for English text.
 */
export function estimateTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    total += Math.ceil(content.length / 4);
  }
  return total;
}

/**
 * Prune a single tool output - truncate if too long.
 */
function pruneToolOutput(content, maxChars = 5000) {
  if (typeof content !== "string") content = JSON.stringify(content);
  if (content.length <= maxChars) return content;

  const headSize = Math.floor(maxChars * 0.6);
  const tailSize = Math.floor(maxChars * 0.3);
  return (
    content.slice(0, headSize) +
    `\n\n[... truncated ${content.length - headSize - tailSize} chars ...]\n\n` +
    content.slice(-tailSize)
  );
}

/**
 * Persist a large tool output to disk and return a reference.
 */
function persistLargeOutput(content, taskId, stepIndex) {
  const dir = `${config.dataDir}/tool-outputs`;
  mkdirSync(dir, { recursive: true });
  const filename = `${taskId || "unknown"}-step${stepIndex}-${Date.now()}.txt`;
  const filePath = `${dir}/${filename}`;
  writeFileSync(filePath, content);
  return `[Output saved to disk: ${filePath} - ${content.length} chars]`;
}

/**
 * Check if compaction is needed and perform it.
 *
 * @param {Array} messages - Current message history
 * @param {object} modelMeta - Model metadata (from models.js) with compactAt threshold
 * @param {string} taskId - Current task ID for file persistence
 * @returns {Array} Possibly compacted messages
 */
export async function compactIfNeeded(messages, modelMeta, taskId = null) {
  const tokenCount = estimateTokens(messages);

  if (tokenCount < modelMeta.compactAt) {
    return messages;
  }

  console.log(
    `[Compaction] Triggered: ~${tokenCount} tokens exceeds threshold ${modelMeta.compactAt}`
  );
  eventBus.emitEvent("compact:triggered", { tokenCount, threshold: modelMeta.compactAt });

  // Step 1: Identify protected messages (system prompt + last 3 exchanges)
  const systemMsg = messages[0]; // always protect system prompt
  const recentCount = 6; // last 3 user+assistant pairs
  const recentMessages = messages.slice(-recentCount);
  const oldMessages = messages.slice(1, -recentCount);

  if (oldMessages.length === 0) {
    // Nothing to compact - all messages are recent
    return messages;
  }

  // Step 2: Prune verbose tool outputs in old messages
  const prunedOld = oldMessages.map((msg, i) => {
    if (msg.role === "developer" || msg.role === "tool") {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      if (content.length > 50000) {
        return { ...msg, content: persistLargeOutput(content, taskId, i) };
      }
      if (content.length > 5000) {
        return { ...msg, content: pruneToolOutput(content) };
      }
    }
    return msg;
  });

  // Step 3: Summarize old messages using a cheap model
  try {
    const { model } = getCheapModel();
    const summaryPrompt = `Summarize the following conversation history concisely. Preserve:
- Key decisions made
- File paths mentioned and their purpose
- Task progress and what was accomplished
- Any errors encountered and how they were resolved
- User preferences or instructions

Conversation to summarize:
${prunedOld.map((m) => `[${m.role}]: ${typeof m.content === "string" ? m.content.slice(0, 2000) : JSON.stringify(m.content).slice(0, 2000)}`).join("\n")}`;

    const { text: summary } = await generateText({
      model,
      messages: [{ role: "user", content: summaryPrompt }],
      maxTokens: 1000,
    });

    const compactedMessages = [
      systemMsg,
      {
        role: "developer",
        content: `<conversation-summary>\nThe following is a summary of earlier conversation that was compacted to save context space:\n\n${summary}\n</conversation-summary>`,
      },
      ...recentMessages,
    ];

    const newTokenCount = estimateTokens(compactedMessages);
    console.log(
      `[Compaction] Done: ${tokenCount} → ~${newTokenCount} tokens (saved ~${tokenCount - newTokenCount})`
    );

    return compactedMessages;
  } catch (error) {
    console.log(`[Compaction] Summarization failed: ${error.message}. Falling back to pruning only.`);

    // Fallback: just prune tool outputs without summarization
    return [systemMsg, ...prunedOld, ...recentMessages];
  }
}
