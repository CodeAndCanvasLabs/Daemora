import { generateText, tool, stepCountIs } from "ai";
import { getCheapModel } from "../models/ModelRouter.js";
import { writeFileSync, mkdirSync } from "fs";
import { config } from "../config/default.js";
import eventBus from "./EventBus.js";
import toolSchemas from "../tools/schemas.js";
import { msgText } from "../utils/msgText.js";

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
    const content = msgText(msg.content) || JSON.stringify(msg.content);
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
 * Run a mini agent loop before compaction so the agent can save important context
 * to memory files. Only uses memory tools. Max 3 turns.
 */
async function runPreCompactionFlush(messages, tools = {}) {
  try {
    const memoryToolNames = ["readMemory", "writeMemory", "writeDailyLog", "readDailyLog"];
    const memoryTools = {};
    for (const name of memoryToolNames) {
      if (tools[name]) memoryTools[name] = tools[name];
    }
    if (Object.keys(memoryTools).length === 0) {
      console.log("[Compaction] No memory tools available - skipping pre-compaction flush");
      return;
    }

    const { model } = getCheapModel();

    // Build native tool definitions with execute functions for the flush agent
    const executableTools = {};
    for (const name of Object.keys(memoryTools)) {
      const entry = toolSchemas[name];
      if (!entry) continue;
      executableTools[name] = tool({
        description: entry.description,
        inputSchema: entry.schema,
        execute: async (params) => {
          const output = await Promise.resolve(memoryTools[name](params));
          const outputStr = typeof output === "string" ? output : JSON.stringify(output);
          console.log(`[Compaction] Pre-flush: ${name} → ${outputStr.slice(0, 100)}`);
          return outputStr;
        },
      });
    }

    const recentMessages = messages.slice(-10);
    const contextSummary = recentMessages
      .map(m => `[${m.role}]: ${(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 500)}`)
      .join("\n");

    const result = await generateText({
      model,
      tools: executableTools,
      stopWhen: stepCountIs(3),
      maxTokens: 2048,
      system: "You are a memory-flush agent. Save important context from the conversation to long-term memory before it gets compacted. Be brief. If nothing important to save, just respond with done.",
      prompt: `Pre-compaction memory flush. The conversation is about to be compacted.\n\nRecent context:\n${contextSummary}\n\nSave important details (decisions, file paths, user preferences, task progress) using writeMemory or writeDailyLog.`,
    });

    const flushSteps = result.toolCalls?.length || 0;
    console.log("[Compaction] Pre-flush complete" + (flushSteps === 0 ? " (nothing to save)" : ` (${flushSteps} tool calls)`));
  } catch (error) {
    console.log(`[Compaction] Pre-flush failed (non-blocking): ${error.message}`);
  }
}

/**
 * Check if compaction is needed and perform it.
 *
 * @param {Array} messages - Current message history
 * @param {object} modelMeta - Model metadata (from models.js) with compactAt threshold
 * @param {string} taskId - Current task ID for file persistence
 * @param {object} [tools] - Available tool functions (used for pre-compaction flush)
 * @returns {Array} Possibly compacted messages
 */
export async function compactIfNeeded(messages, modelMeta, taskId = null, tools = {}) {
  const tokenCount = estimateTokens(messages);

  // Dynamic threshold: compact when within 10k tokens of the model's context window
  const contextLimit = modelMeta.contextWindow || 128_000;
  const compactThreshold = Math.max(contextLimit - 10_000, modelMeta.compactAt || 90_000);

  if (tokenCount < compactThreshold) {
    return messages;
  }

  console.log(
    `[Compaction] Triggered: ~${tokenCount} tokens exceeds threshold ${compactThreshold} (context: ${contextLimit})`
  );
  eventBus.emitEvent("compact:triggered", { tokenCount, threshold: compactThreshold });

  // Pre-compaction memory flush - let agent save important context before we compact
  await runPreCompactionFlush(messages, tools);

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
      const content = msgText(msg.content) || JSON.stringify(msg.content);
      if (content.length > 50000) {
        return { ...msg, content: persistLargeOutput(content, taskId, i) };
      }
      if (content.length > 5000) {
        return { ...msg, content: pruneToolOutput(content) };
      }
    }
    return msg;
  });

  // Step 3: Summarize old messages using the same model (or cheap fallback)
  try {
    let model;
    try {
      // Prefer the same model the agent is using for consistent quality
      const { getModelWithFallback } = await import("../models/ModelRouter.js");
      const resolved = getModelWithFallback(modelMeta.provider ? `${modelMeta.provider}:${modelMeta.model}` : null);
      model = resolved.model;
    } catch {
      const cheap = getCheapModel();
      model = cheap.model;
    }

    const summaryPrompt = `Summarize the following conversation history concisely. You MUST preserve:
- What was done (completed steps)
- What is left to do (pending work, next steps)
- Key decisions made and why
- File paths mentioned and their purpose
- Any errors encountered and how they were resolved
- User preferences, instructions, or constraints
- Current task status (in progress, blocked, etc.)

Format as a structured summary with clear sections.

Conversation to summarize:
${prunedOld.map((m) => `[${m.role}]: ${(msgText(m.content) || JSON.stringify(m.content)).slice(0, 2000)}`).join("\n")}`;

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
