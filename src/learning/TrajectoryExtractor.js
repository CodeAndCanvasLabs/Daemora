/**
 * TrajectoryExtractor — post-task learning from execution trajectories.
 *
 * After a completed task with 3+ tool calls, analyzes the execution
 * and extracts reusable learnings: strategy tips, recovery patterns,
 * optimization insights.
 *
 * Stored in learning_entries table (per-tenant, searchable via embeddings).
 * System prompt includes relevant learnings at task start.
 *
 * Inspired by Hermes Agent's trajectory saving, but goes further:
 * Hermes saves raw trajectories for RL training — we extract actionable
 * learnings and inject them into future tasks.
 */

import { run, queryAll, queryOne } from "../storage/Database.js";
import { generateText } from "ai";
import { getModelWithFallback, getCheapModel } from "../models/ModelRouter.js";
import { generateEmbedding, cosineSim } from "../utils/Embeddings.js";

// ── Thresholds ──────────────────────────────────────────────────────────────

const MIN_TOOL_CALLS = 3;          // Minimum tool calls to consider extraction
const MAX_LEARNINGS_PER_TASK = 3;  // Max entries per task
const DEDUP_THRESHOLD = 0.85;      // Cosine similarity threshold for dedup
const MAX_LEARNINGS_PER_TENANT = 200; // Prune oldest beyond this

// ── Extraction ──────────────────────────────────────────────────────────────

/**
 * Extract learnings from a completed task.
 * Called post-task from TaskRunner (fire-and-forget).
 *
 * @param {object} task - Completed task { id, input, tenantId }
 * @param {object} result - Agent result { text, toolCalls, cost }
 * @param {object} apiKeys - Per-tenant API keys
 */
export async function extractLearnings(task, result, apiKeys = {}) {
  try {
    const toolCalls = result.toolCalls || [];
    if (toolCalls.length < MIN_TOOL_CALLS) return;

    // Skip trivial tasks (greetings, simple lookups)
    const input = task.input || "";
    if (input.length < 80) return;

    // Build trajectory summary for the extractor model
    const trajectory = _buildTrajectory(input, toolCalls, result.text);

    // Use cheap model for extraction (cost-efficient)
    const { model, modelId } = getCheapModel(apiKeys);
    if (!model) return; // No model available

    const extraction = await generateText({
      model,
      system: EXTRACTOR_PROMPT,
      messages: [{ role: "user", content: trajectory }],
      maxTokens: 1024,
      temperature: 0.2,
    });

    const learnings = _parseLearnings(extraction.text);
    if (!learnings || learnings.length === 0) return;

    // Deduplicate against existing learnings
    const tenantId = task.tenantId || null;
    const toolNames = [...new Set(toolCalls.map(tc => tc.tool || tc.name).filter(Boolean))].join(",");

    for (const learning of learnings.slice(0, MAX_LEARNINGS_PER_TASK)) {
      const isDuplicate = await _isDuplicate(tenantId, learning.content);
      if (isDuplicate) continue;

      // Generate embedding for future retrieval
      let embedding = null;
      try {
        const vec = await generateEmbedding(learning.content);
        if (vec) embedding = JSON.stringify(vec);
      } catch {}

      run(
        `INSERT INTO learning_entries (tenant_id, task_id, category, content, tool_names, embedding)
         VALUES ($tid, $taskId, $cat, $content, $tools, $emb)`,
        {
          $tid: tenantId,
          $taskId: task.id,
          $cat: learning.category || "strategy",
          $content: learning.content,
          $tools: toolNames,
          $emb: embedding,
        }
      );
    }

    // Prune if too many entries
    _pruneOldLearnings(tenantId);

    console.log(`[TrajectoryExtractor] Extracted ${learnings.length} learning(s) from task ${task.id?.slice(0, 8)}`);
  } catch (err) {
    // Never crash the post-task pipeline
    console.log(`[TrajectoryExtractor] Non-fatal error: ${err.message}`);
  }
}

// ── Retrieval (for system prompt injection) ─────────────────────────────────

/**
 * Get relevant learnings for a task input.
 * Called by systemPrompt.js to inject learnings into system prompt.
 *
 * @param {string} taskInput - Current task description
 * @param {string|null} tenantId - Tenant ID (null for global)
 * @param {number} limit - Max entries to return
 * @returns {string} Formatted learnings for system prompt
 */
export async function getRelevantLearnings(taskInput, tenantId = null, limit = 5) {
  try {
    // Load all learnings for this tenant
    const rows = tenantId
      ? queryAll("SELECT content, category, tool_names, embedding FROM learning_entries WHERE tenant_id = $tid ORDER BY id DESC LIMIT 100", { $tid: tenantId })
      : queryAll("SELECT content, category, tool_names, embedding FROM learning_entries WHERE tenant_id IS NULL ORDER BY id DESC LIMIT 100");

    if (rows.length === 0) return "";

    // Semantic ranking if embeddings available
    let ranked = rows;
    try {
      const queryVec = await generateEmbedding(taskInput);
      if (queryVec) {
        ranked = rows
          .map(r => {
            let score = 0;
            if (r.embedding) {
              try { score = cosineSim(queryVec, JSON.parse(r.embedding)); } catch {}
            }
            return { ...r, score };
          })
          .filter(r => r.score > 0.3)
          .sort((a, b) => b.score - a.score);
      }
    } catch {}

    const top = ranked.slice(0, limit);
    if (top.length === 0) return "";

    const items = top.map(r => `- [${r.category}] ${r.content}`).join("\n");
    return `# Learnings from Past Tasks\n\nApply these if relevant to the current task:\n${items}`;
  } catch {
    return "";
  }
}

// ── Internal ────────────────────────────────────────────────────────────────

function _buildTrajectory(input, toolCalls, resultText) {
  const tools = toolCalls.map((tc, i) => {
    const name = tc.tool || tc.name || "unknown";
    const status = tc.status || "success";
    const output = (tc.output_preview || "").slice(0, 200);
    return `Step ${i + 1}: ${name} [${status}]${output ? ` → ${output}` : ""}`;
  }).join("\n");

  return `TASK: ${input.slice(0, 500)}

EXECUTION (${toolCalls.length} tool calls):
${tools}

RESULT: ${(resultText || "").slice(0, 500)}`;
}

const EXTRACTOR_PROMPT = `You analyze completed AI agent task executions and extract reusable learnings.

Output 1-3 learnings as a JSON array. Each learning has:
- category: "strategy" (what approach worked) | "recovery" (how errors were handled) | "optimization" (faster/better path found)
- content: One concise sentence — actionable, specific, reusable for similar future tasks

Rules:
- Only extract genuinely reusable insights (not task-specific details)
- Skip trivial learnings ("use readFile to read files")
- Focus on non-obvious patterns, tool combinations, sequencing that worked
- If the task was too simple or nothing interesting happened, return empty array: []

Output ONLY the JSON array. No markdown, no explanation.

Example: [{"category":"strategy","content":"When debugging Node.js import errors, check package.json type field before investigating the import statement itself"},{"category":"recovery","content":"If editFile fails with 'old_string not found', re-read the file first — content may have changed since last read"}]`;

function _parseLearnings(text) {
  try {
    // Extract JSON array from response (may have markdown wrapping)
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(l => l.content && l.category && l.content.length > 20 && l.content.length < 500);
  } catch {
    return [];
  }
}

async function _isDuplicate(tenantId, content) {
  try {
    const vec = await generateEmbedding(content);
    if (!vec) return false;

    const rows = tenantId
      ? queryAll("SELECT embedding FROM learning_entries WHERE tenant_id = $tid AND embedding IS NOT NULL ORDER BY id DESC LIMIT 50", { $tid: tenantId })
      : queryAll("SELECT embedding FROM learning_entries WHERE tenant_id IS NULL AND embedding IS NOT NULL ORDER BY id DESC LIMIT 50");

    for (const row of rows) {
      try {
        const existing = JSON.parse(row.embedding);
        if (cosineSim(vec, existing) > DEDUP_THRESHOLD) return true;
      } catch {}
    }
    return false;
  } catch {
    return false;
  }
}

function _pruneOldLearnings(tenantId) {
  try {
    const countRow = tenantId
      ? queryOne("SELECT COUNT(*) as cnt FROM learning_entries WHERE tenant_id = $tid", { $tid: tenantId })
      : queryOne("SELECT COUNT(*) as cnt FROM learning_entries WHERE tenant_id IS NULL");

    if ((countRow?.cnt || 0) > MAX_LEARNINGS_PER_TENANT) {
      const excess = countRow.cnt - MAX_LEARNINGS_PER_TENANT;
      if (tenantId) {
        run("DELETE FROM learning_entries WHERE id IN (SELECT id FROM learning_entries WHERE tenant_id = $tid ORDER BY id ASC LIMIT $n)", { $tid: tenantId, $n: excess });
      } else {
        run("DELETE FROM learning_entries WHERE id IN (SELECT id FROM learning_entries WHERE tenant_id IS NULL ORDER BY id ASC LIMIT $n)", { $n: excess });
      }
    }
  } catch {}
}
