/**
 * tokenEstimate — cheap ~chars/4 token estimator.
 *
 * Good enough for deciding when to compact (off by 10–30%). A proper
 * tokenizer (tiktoken / Anthropic) can replace this later; the
 * callsites only care about order of magnitude.
 */

import type { ModelMessage } from "ai";

import { msgText } from "./msgText.js";

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(msg: ModelMessage): number {
  return estimateTokens(msgText(msg.content));
}

export function estimateMessagesTokens(messages: readonly ModelMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}
