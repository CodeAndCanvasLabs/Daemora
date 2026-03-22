/**
 * UserProfiler — auto-learn user preferences from interaction patterns.
 *
 * Instead of a separate PROFILE.md, this enhances the existing memory system
 * by auto-capturing user preferences into memory with category "profile".
 *
 * Runs every N tasks per tenant. Analyzes recent interactions to detect:
 * - Communication style (verbose vs terse, bullets vs prose)
 * - Technical level (adjusts explanation depth)
 * - Common topics (what they ask about most)
 * - Corrections (things user has corrected the agent on)
 * - Tool preferences (which tools they trigger most)
 *
 * Edge cases:
 * - Doesn't overwrite explicit user instructions in MEMORY.md
 * - Rate-limited (max 1 profile update per 10 tasks)
 * - Conflict detection (doesn't contradict existing profile entries)
 * - Tenant isolation (per-tenant profiling)
 */

import { queryAll, queryOne, run } from "../storage/Database.js";
import { generateText } from "ai";
import { getCheapModel } from "../models/ModelRouter.js";

// ── Thresholds ──────────────────────────────────────────────────────────────

const PROFILE_INTERVAL = 10;        // Run every N tasks per tenant
const MAX_PROFILE_ENTRIES = 10;     // Max profile entries in memory
const MIN_TASKS_FOR_PROFILE = 5;    // Need at least this many tasks before profiling

// Track task count per tenant for rate limiting
const _taskCounts = new Map(); // tenantId → count

/**
 * Maybe update user profile based on recent interactions.
 * Called post-task from TaskRunner (fire-and-forget).
 *
 * @param {object} task - Completed task { id, input, tenantId }
 * @param {object} result - Agent result { text, toolCalls }
 * @param {object} apiKeys - Per-tenant API keys
 */
export async function maybeUpdateProfile(task, result, apiKeys = {}) {
  try {
    const tenantId = task.tenantId || "__global__";

    // Rate limit: only run every N tasks
    const count = (_taskCounts.get(tenantId) || 0) + 1;
    _taskCounts.set(tenantId, count);
    if (count % PROFILE_INTERVAL !== 0) return;

    // Need minimum task history
    const taskCount = queryOne(
      "SELECT COUNT(*) as cnt FROM tasks WHERE tenant_id = $tid AND status = 'completed'",
      { $tid: task.tenantId || null }
    );
    if ((taskCount?.cnt || 0) < MIN_TASKS_FOR_PROFILE) return;

    // Load recent task inputs + results for analysis
    const recentTasks = queryAll(
      `SELECT input, result FROM tasks
       WHERE ${task.tenantId ? "tenant_id = $tid" : "tenant_id IS NULL"}
       AND status = 'completed' AND input IS NOT NULL AND result IS NOT NULL
       ORDER BY completed_at DESC LIMIT 20`,
      task.tenantId ? { $tid: task.tenantId } : {}
    );

    if (recentTasks.length < 5) return;

    // Load existing profile entries from memory
    const existingProfile = queryAll(
      `SELECT content FROM memory_entries
       WHERE ${task.tenantId ? "tenant_id = $tid" : "tenant_id IS NULL"}
       AND category = 'profile'`,
      task.tenantId ? { $tid: task.tenantId } : {}
    );

    const existingEntries = existingProfile.map(r => r.content).join("\n");

    // Build interaction summary for profiler
    const interactions = recentTasks.map(t => {
      const inp = (t.input || "").slice(0, 150);
      const res = (t.result || "").slice(0, 150);
      return `User: ${inp}\nAgent: ${res}`;
    }).join("\n---\n");

    const { model } = getCheapModel(apiKeys);
    if (!model) return;

    const profileResult = await generateText({
      model,
      system: PROFILER_PROMPT,
      messages: [{
        role: "user",
        content: `EXISTING PROFILE:\n${existingEntries || "(none yet)"}\n\nRECENT INTERACTIONS (last ${recentTasks.length}):\n${interactions}`,
      }],
      maxTokens: 512,
      temperature: 0.2,
    });

    const newEntries = _parseProfileEntries(profileResult.text);
    if (!newEntries || newEntries.length === 0) return;

    // Write new profile entries to memory (replace category "profile")
    // Clear old profile entries first
    if (task.tenantId) {
      run("DELETE FROM memory_entries WHERE tenant_id = $tid AND category = 'profile'", { $tid: task.tenantId });
    } else {
      run("DELETE FROM memory_entries WHERE tenant_id IS NULL AND category = 'profile'");
    }

    // Insert new profile entries
    for (const entry of newEntries.slice(0, MAX_PROFILE_ENTRIES)) {
      run(
        `INSERT INTO memory_entries (tenant_id, content, category, timestamp)
         VALUES ($tid, $content, 'profile', datetime('now'))`,
        { $tid: task.tenantId || null, $content: entry }
      );
    }

    console.log(`[UserProfiler] Updated profile for ${tenantId} (${newEntries.length} entries)`);
  } catch (err) {
    console.log(`[UserProfiler] Non-fatal error: ${err.message}`);
  }
}

// ── Internal ────────────────────────────────────────────────────────────────

const PROFILER_PROMPT = `You analyze user-agent interactions to build a user profile. The profile helps the agent tailor responses.

Given recent interactions and any existing profile, output updated profile entries. Each entry is one observation about the user.

Focus on:
- Communication preference (terse vs detailed, bullets vs prose, emoji usage)
- Technical level (beginner, intermediate, expert — in what domains)
- Common topics (what they ask about repeatedly)
- Working patterns (tools they trigger, task types they request)
- Explicit corrections (things they've told the agent to do differently)

Rules:
- Keep existing accurate entries, update if evidence contradicts
- Max 10 entries total
- Each entry: one sentence, factual, actionable for the agent
- Don't invent preferences without evidence — only what the interactions show
- If interactions are too few or too varied to detect patterns, output: SKIP

Output one entry per line. No numbering, no bullets. Just plain sentences.
Example:
Prefers short responses with bullet points over paragraphs
Expert-level Node.js developer, intermediate with Python
Frequently asks about database optimization and CI/CD
Corrected agent: never add emojis to responses
Most active during weekday mornings (UTC+5)`;

function _parseProfileEntries(text) {
  if (!text || text.trim() === "SKIP") return null;
  return text.split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 10 && line.length < 300)
    .filter(line => !line.startsWith("#") && !line.startsWith("-") && !line.startsWith("*") && !line.match(/^\d+\./));
}
