/**
 * Backward-compatible wrapper around the new AgentLoop.
 *
 * The original runAgent() interface is preserved so existing code
 * (index.js POST /chat) continues to work without changes.
 *
 * New code should import from src/core/AgentLoop.js directly.
 */
import { runAgentLoop } from "../core/AgentLoop.js";

export async function runAgent({ messages, systemPrompt, tools, modelId = null }) {
  const result = await runAgentLoop({
    messages,
    systemPrompt,
    tools,
    modelId,
  });

  // Return in the same shape the old code expects
  return {
    text: result.text,
    messages: result.messages,
    cost: result.cost,
  };
}
