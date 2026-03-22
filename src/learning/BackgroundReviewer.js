/**
 * BackgroundReviewer — post-task background agent that reviews conversations
 * for memory/profile updates and skill creation opportunities.
 *
 * Pattern: Hermes Agent's proven approach.
 *
 * Flow:
 * 1. Track tool iterations during task (via AgentLoop stepCount)
 * 2. After task completes + response delivered, spawn background sub-agent
 * 3. Sub-agent gets full conversation history + review prompt
 * 4. Sub-agent calls memory/writeFile tools to save learnings + skills
 * 5. Never blocks user response — fire-and-forget
 *
 * Combined review handles:
 * - Memory updates (user preferences, corrections, patterns)
 * - Skill creation (non-trivial approaches worth reusing)
 *
 * Thresholds (matching Hermes):
 * - Memory review: every 10 user turns
 * - Skill review: every 10 tool iterations
 * - Combined: if both trigger, one review handles both
 */

import { spawnSubAgent } from "../agents/SubAgentManager.js";
import tenantContext from "../tenants/TenantContext.js";

// ── Thresholds ──────────────────────────────────────────────────────────────

const SKILL_NUDGE_INTERVAL = 10;    // Tool iterations before skill review
const MEMORY_NUDGE_INTERVAL = 10;   // User turns before memory review
const MAX_REVIEW_ITERATIONS = 8;    // Max tool calls for the review agent

// Per-tenant counters (reset after review fires)
const _skillIterCounts = new Map();  // tenantKey → count
const _memoryTurnCounts = new Map(); // tenantKey → count

// ── Review Prompts (from Hermes, adapted) ───────────────────────────────────

const SKILL_REVIEW_PROMPT =
  `Review the conversation above and consider saving or updating a skill if appropriate.

Focus on: was a non-trivial approach used to complete a task that required trial and error, or changing course due to experiential findings, or did the user expect a different method or outcome?

If the approach is reusable, create a skill file:
1. Read skills/skill-creator/SKILL.md for the format (use readFile)
2. Write the new skill to skills/<skill-name>/SKILL.md (use writeFile)

The skill must have YAML frontmatter (name, description, triggers) + step-by-step instructions.

If a relevant skill already exists (check with glob("skills/*/SKILL.md")), update it instead.
If nothing is worth saving, respond with "Nothing to save." and stop.`;

const MEMORY_REVIEW_PROMPT =
  `Review the conversation above and consider saving to memory if appropriate.

Focus on:
1. Has the user revealed things about themselves — persona, preferences, personal details worth remembering?
2. Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate?
3. Has the user corrected you on something you should remember?

If something stands out, save it using writeMemory with category "profile".
If nothing is worth saving, respond with "Nothing to save." and stop.`;

const COMBINED_REVIEW_PROMPT =
  `Review the conversation above and consider two things:

**Memory**: Has the user revealed things about themselves — persona, preferences, personal details? Has the user expressed expectations about how you should behave, their work style, or corrections? If so, save using writeMemory with category "profile".

**Skills**: Was a non-trivial approach used that required trial and error, or changing course? If the approach is reusable:
1. Read skills/skill-creator/SKILL.md for the format
2. Write the new skill to skills/<skill-name>/SKILL.md
If a relevant skill already exists, update it instead.

Only act if there's something genuinely worth saving.
If nothing stands out, respond with "Nothing to save." and stop.`;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Record a tool iteration for skill review tracking.
 * Called from AgentLoop after each tool call.
 *
 * @param {string|null} tenantId
 */
export function recordToolIteration(tenantId) {
  const key = tenantId || "__global__";
  _skillIterCounts.set(key, (_skillIterCounts.get(key) || 0) + 1);
}

/**
 * Record a user turn for memory review tracking.
 * Called from TaskRunner when processing a user message.
 *
 * @param {string|null} tenantId
 */
export function recordUserTurn(tenantId) {
  const key = tenantId || "__global__";
  _memoryTurnCounts.set(key, (_memoryTurnCounts.get(key) || 0) + 1);
}

/**
 * Run background review if thresholds met.
 * Called post-task from TaskRunner (fire-and-forget).
 *
 * @param {object} task - Completed task
 * @param {object} result - Agent result { text, toolCalls, messages }
 * @param {object} apiKeys - Per-tenant API keys
 */
export async function maybeRunReview(task, result, apiKeys = {}) {
  try {
    // Skip sub-agent tasks, watcher/cron (they follow instructions, not novel)
    if (task.type === "watcher" || task.type === "cron") return;
    if (!result.text) return;

    const key = task.tenantId || "__global__";

    // Check thresholds
    const skillIters = _skillIterCounts.get(key) || 0;
    const memoryTurns = _memoryTurnCounts.get(key) || 0;

    const shouldReviewSkills = skillIters >= SKILL_NUDGE_INTERVAL;
    const shouldReviewMemory = memoryTurns >= MEMORY_NUDGE_INTERVAL;

    if (!shouldReviewSkills && !shouldReviewMemory) return;

    // Reset counters
    if (shouldReviewSkills) _skillIterCounts.set(key, 0);
    if (shouldReviewMemory) _memoryTurnCounts.set(key, 0);

    // Pick prompt
    let reviewPrompt;
    if (shouldReviewSkills && shouldReviewMemory) {
      reviewPrompt = COMBINED_REVIEW_PROMPT;
    } else if (shouldReviewSkills) {
      reviewPrompt = SKILL_REVIEW_PROMPT;
    } else {
      reviewPrompt = MEMORY_REVIEW_PROMPT;
    }

    // Build conversation context for the review agent
    const conversationContext = _buildConversationSummary(task, result);

    console.log(`[BackgroundReviewer] Spawning review agent (skills: ${shouldReviewSkills}, memory: ${shouldReviewMemory}) for tenant ${key}`);

    // Spawn background review agent — fire-and-forget
    // Uses a minimal tool set: readFile, writeFile, glob, grep, memory tools
    // No orchestration tools, no blast-radius tools
    spawnSubAgent(reviewPrompt, {
      parentContext: conversationContext,
      tools: [
        "readFile", "writeFile", "glob", "grep", "listDirectory",
        "readMemory", "writeMemory", "searchMemory",
      ],
      systemPromptOverride: {
        role: "system",
        content: `You are a background review agent. You analyze completed conversations and save useful learnings — either as memory entries (user preferences, corrections) or as skill files (reusable procedures).

Rules:
- Be selective. Only save genuinely useful insights.
- For skills: follow the exact format in skills/skill-creator/SKILL.md.
- For memory: use writeMemory with category "profile" for user preferences, "learning" for task insights.
- If nothing is worth saving, say "Nothing to save." and stop immediately.
- Never ask for clarification. Decide based on the conversation.
- Maximum ${MAX_REVIEW_ITERATIONS} tool calls.`,
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

function _buildConversationSummary(task, result) {
  const toolCalls = result.toolCalls || [];
  const toolNames = [...new Set(toolCalls.map(tc => tc.tool || tc.name).filter(Boolean))];

  const toolSteps = toolCalls.slice(0, 20).map((tc, i) => {
    const name = tc.tool || tc.name || "unknown";
    const status = tc.status || "success";
    const output = (tc.output_preview || "").slice(0, 150);
    return `  ${i + 1}. ${name} [${status}]${output ? ` → ${output}` : ""}`;
  }).join("\n");

  return `CONVERSATION SUMMARY:

User request: ${(task.input || "").slice(0, 500)}

Tools used (${toolCalls.length} calls, ${toolNames.length} unique): ${toolNames.join(", ")}
${toolSteps ? `\nExecution:\n${toolSteps}` : ""}

Agent response: ${(result.text || "").slice(0, 500)}`;
}
