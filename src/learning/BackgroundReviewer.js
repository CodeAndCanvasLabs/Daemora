/**
 * BackgroundReviewer — post-task background agent for memory + skill learning.
 *
 * Pattern: Hermes Agent (exact approach, proven at scale).
 *
 * Flow:
 * 1. AgentLoop tracks tool iterations per-task (not per-tenant)
 * 2. After task completes, check thresholds on THAT task's metrics
 * 3. If threshold met, spawn background sub-agent with full conversation messages
 * 4. Review agent has full context — decides what to save
 * 5. Saves to memory (user preferences) or skills (reusable procedures)
 * 6. Never blocks user response
 *
 * Purpose: improve the MAIN agent's future behavior by:
 * - Remembering user preferences, corrections, patterns
 * - Creating/updating reusable skill documents
 *
 * Prompts copied from Hermes Agent (run_agent.py lines 1319-1352).
 */

import { spawnSubAgent } from "../agents/SubAgentManager.js";

// ── Thresholds ──────────────────────────────────────────────────────────────

const SKILL_NUDGE_INTERVAL = 10;    // Tool calls in ONE task before skill review triggers
const MIN_TOOL_CALLS_FOR_REVIEW = 3; // Minimum tool calls to even consider review

// ── Review Prompts (from Hermes run_agent.py lines 1319-1352) ───────────────

const MEMORY_REVIEW_PROMPT =
  `Review the conversation above and consider saving to memory if appropriate.

Focus on:
1. Has the user revealed things about themselves — their persona, desires, preferences, or personal details worth remembering?
2. Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate?

If something stands out, save it using writeMemory with category "profile".
If nothing is worth saving, just say "Nothing to save." and stop.`;

const SKILL_REVIEW_PROMPT =
  `Review the conversation above and consider saving or updating a skill if appropriate.

Focus on: was a non-trivial approach used to complete a task that required trial and error, or changing course due to experiential findings along the way, or did the user expect or desire a different method or outcome?

If a relevant skill already exists, update it with what you learned. Otherwise, create a new skill if the approach is reusable.

To create a skill:
1. Read skills/skill-creator/SKILL.md for the exact format (use readFile)
2. Write the new skill to skills/<skill-name>/SKILL.md (use writeFile)

If nothing is worth saving, just say "Nothing to save." and stop.`;

const COMBINED_REVIEW_PROMPT =
  `Review the conversation above and consider two things:

**Memory**: Has the user revealed things about themselves — their persona, desires, preferences, or personal details? Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate? If so, save using writeMemory with category "profile".

**Skills**: Was a non-trivial approach used to complete a task that required trial and error, or changing course due to experiential findings along the way, or did the user expect or desire a different method or outcome? If a relevant skill already exists, update it. Otherwise, create a new one if the approach is reusable.

To create a skill: read skills/skill-creator/SKILL.md for the format, then write to skills/<skill-name>/SKILL.md.

Only act if there's something genuinely worth saving.
If nothing stands out, just say "Nothing to save." and stop.`;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Run background review if thresholds met for THIS task.
 * Called post-task from TaskRunner (fire-and-forget).
 *
 * @param {object} task - Completed task { id, input, tenantId, type }
 * @param {object} result - Agent result { text, toolCalls, messages }
 * @param {object} options - { apiKeys, turnCount }
 */
export async function maybeRunReview(task, result, options = {}) {
  try {
    // Skip non-user tasks (sub-agents, watchers, cron create their own context)
    if (task.type === "watcher" || task.type === "cron") return;
    if (!result.text) return;

    const toolCallCount = (result.toolCalls || []).length;

    // Minimum bar: at least 3 tool calls to bother reviewing
    if (toolCallCount < MIN_TOOL_CALLS_FOR_REVIEW) return;

    // Decide what to review based on THIS task's metrics
    const shouldReviewSkills = toolCallCount >= SKILL_NUDGE_INTERVAL;
    // Memory review: always when we hit the minimum bar (agent decides what's worth saving)
    const shouldReviewMemory = true;

    // Pick the right prompt
    let reviewPrompt;
    if (shouldReviewSkills && shouldReviewMemory) {
      reviewPrompt = COMBINED_REVIEW_PROMPT;
    } else if (shouldReviewSkills) {
      reviewPrompt = SKILL_REVIEW_PROMPT;
    } else {
      reviewPrompt = MEMORY_REVIEW_PROMPT;
    }

    // Build history messages from the completed conversation
    // This is the KEY difference from our old approach — full messages, not a summary
    const historyMessages = _buildHistoryMessages(result.messages);
    if (historyMessages.length < 2) return; // Need at least user + assistant

    const reviewType = shouldReviewSkills ? "skills+memory" : "memory";
    console.log(`[BackgroundReviewer] Spawning ${reviewType} review (${toolCallCount} tool calls in task ${task.id?.slice(0, 8)})`);

    // Spawn background review agent with the FULL conversation
    // Agent sees everything that happened, then decides what to save
    spawnSubAgent(reviewPrompt, {
      historyMessages,
      tools: [
        "readFile", "writeFile", "editFile", "glob", "grep", "listDirectory",
        "readMemory", "writeMemory", "searchMemory",
      ],
      systemPromptOverride: {
        role: "system",
        content: `You are a background review agent. Your job: analyze the completed conversation and save useful learnings.

You have the full conversation history. Review it and:
- Save user preferences/corrections to memory (writeMemory with category "profile")
- Create reusable skills if the approach was non-trivial (read skills/skill-creator/SKILL.md for format, then writeFile)

Rules:
- Be selective. Only save genuinely useful, reusable insights.
- For skills: only when the approach involved trial-and-error, non-obvious tool combinations, or recovery from errors.
- For memory: only user preferences, corrections, or behavioral patterns — not task details.
- If nothing is worth saving, say "Nothing to save." and stop immediately.
- Never ask for clarification.
- You have max 8 tool calls. Be efficient.`,
      },
      maxCost: 0.02,
      timeout: 120_000,
      depth: 1,
    }).catch(err => {
      console.log(`[BackgroundReviewer] Review failed (non-fatal): ${err.message}`);
    });
  } catch (err) {
    console.log(`[BackgroundReviewer] Non-fatal error: ${err.message}`);
  }
}

// ── Internal ────────────────────────────────────────────────────────────────

/**
 * Build clean history messages from the completed conversation.
 * Strips tool-call/tool-result internals — review agent only needs
 * the user messages and assistant text responses.
 */
function _buildHistoryMessages(messages) {
  if (!messages || !Array.isArray(messages)) return [];

  const clean = [];
  for (const msg of messages) {
    if (!msg || !msg.role) continue;

    // Keep user messages (the requests)
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      if (!text) continue;
      // Skip system injections
      if (text.startsWith("[Supervisor instruction]:")) continue;
      if (text.startsWith("[System:")) continue;
      clean.push({ role: "user", content: text.slice(0, 2000) });
    }

    // Keep assistant text responses (the actions/decisions)
    if (msg.role === "assistant") {
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter(p => p.type === "text").map(p => p.text).join("\n")
          : "";
      if (text) {
        clean.push({ role: "assistant", content: text.slice(0, 2000) });
      }
    }
  }

  // Cap at 20 messages to keep review cost low
  return clean.slice(-20);
}
