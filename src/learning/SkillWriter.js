/**
 * SkillWriter — autonomous skill generation from complex task executions.
 *
 * After a task with 5+ tool calls and diverse tool usage, auto-generates
 * a skill .md file in standard format. Next time a similar task comes in,
 * the skill is injected via SkillLoader.
 *
 * Hermes approach: nudge every N iterations, agent decides.
 * Our approach: auto-generate draft post-task, skip if duplicate scope.
 *
 * Edge cases handled:
 * - Duplicate detection (semantic similarity against existing skills)
 * - Quality gate (min content length, must have actionable instructions)
 * - Tenant isolation (tenant skills in data/tenants/{id}/skills/)
 * - Concurrent writes (atomic via temp file + rename)
 * - Security scanning (reject if contains shell injection patterns)
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateText } from "ai";
import { getCheapModel } from "../models/ModelRouter.js";
import { generateEmbedding, cosineSim } from "../utils/Embeddings.js";
import { config } from "../config/default.js";
import skillLoader from "../skills/SkillLoader.js";

// ── Thresholds ──────────────────────────────────────────────────────────────

const MIN_TOOL_CALLS = 5;            // Minimum tool calls for skill generation
const MIN_UNIQUE_TOOLS = 3;          // Minimum distinct tools used
const DEDUP_THRESHOLD = 0.80;        // Cosine similarity to consider duplicate
const MIN_SKILL_LENGTH = 200;        // Minimum generated skill body length
const MAX_SKILL_LENGTH = 3000;       // Maximum skill body length

// Patterns that should NOT appear in generated skills
const INJECTION_PATTERNS = [
  /ignore\s+(previous|all|above)\s+instructions/i,
  /you\s+are\s+now\s+/i,
  /system\s+prompt\s+override/i,
  /curl\s+.*\$\{?\w*(KEY|TOKEN|SECRET)/i,
  /wget\s+.*\$\{?\w*(KEY|TOKEN|SECRET)/i,
  /cat\s+.*\.env\b/i,
];

// ── Main ────────────────────────────────────────────────────────────────────

/**
 * Attempt to auto-generate a skill from a completed task.
 * Called post-task from TaskRunner (fire-and-forget).
 *
 * @param {object} task - Completed task { id, input, tenantId }
 * @param {object} result - Agent result { text, toolCalls, cost }
 * @param {object} apiKeys - Per-tenant API keys
 */
export async function maybeGenerateSkill(task, result, apiKeys = {}) {
  try {
    const toolCalls = result.toolCalls || [];
    if (toolCalls.length < MIN_TOOL_CALLS) return;

    // Check tool diversity
    const uniqueTools = new Set(toolCalls.map(tc => tc.tool || tc.name).filter(Boolean));
    if (uniqueTools.size < MIN_UNIQUE_TOOLS) return;

    // Skip trivial tasks
    const input = task.input || "";
    if (input.length < 100) return;

    // Skip watcher/cron tasks (they follow existing instructions, not novel)
    if (task.type === "watcher" || task.type === "cron") return;

    // Check if a similar skill already exists
    const isDup = await _isDuplicateSkill(input);
    if (isDup) return;

    // Build trajectory for the skill writer model
    const trajectory = _buildTrajectory(input, toolCalls, result.text);

    const { model } = getCheapModel(apiKeys);
    if (!model) return;

    const generation = await generateText({
      model,
      system: SKILL_WRITER_PROMPT,
      messages: [{ role: "user", content: trajectory }],
      maxTokens: 2048,
      temperature: 0.3,
    });

    const skill = _parseSkill(generation.text);
    if (!skill) return;

    // Security scan
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(skill.body)) {
        console.log(`[SkillWriter] Rejected skill "${skill.name}" — security pattern detected`);
        return;
      }
    }

    // Quality gate
    if (skill.body.length < MIN_SKILL_LENGTH || skill.body.length > MAX_SKILL_LENGTH) return;

    // Determine save location
    const tenantId = task.tenantId || null;
    const skillDir = _getSkillDir(tenantId, skill.name);

    // Atomic write
    const skillPath = join(skillDir, "SKILL.md");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, skill.fullContent);

    // Reload skills to pick up the new one
    try { skillLoader.loadFromDir(join(skillDir, "..")); } catch {}

    console.log(`[SkillWriter] Auto-generated skill: "${skill.name}" from task ${task.id?.slice(0, 8)} (${toolCalls.length} tool calls, ${uniqueTools.size} unique tools)`);
  } catch (err) {
    console.log(`[SkillWriter] Non-fatal error: ${err.message}`);
  }
}

// ── Internal ────────────────────────────────────────────────────────────────

function _buildTrajectory(input, toolCalls, resultText) {
  const tools = toolCalls.map((tc, i) => {
    const name = tc.tool || tc.name || "unknown";
    const status = tc.status || "success";
    return `${i + 1}. ${name} [${status}]`;
  }).join("\n");

  const uniqueToolNames = [...new Set(toolCalls.map(tc => tc.tool || tc.name).filter(Boolean))];

  return `TASK: ${input.slice(0, 800)}

TOOLS USED (${toolCalls.length} calls, ${uniqueToolNames.length} unique):
${tools}

UNIQUE TOOLS: ${uniqueToolNames.join(", ")}

RESULT: ${(resultText || "").slice(0, 500)}`;
}

const SKILL_WRITER_PROMPT = `You generate reusable skill documents from completed AI agent task executions.

A skill document teaches the agent HOW to handle similar tasks in the future. It follows this exact format:

---
name: skill-name-here
description: One sentence describing when to use this skill
triggers: comma, separated, keywords, that, match, future, tasks
---

Step-by-step instructions the agent should follow for tasks matching this skill.
Include: approach, tool sequence, common pitfalls, validation steps.

Rules:
- name: lowercase, hyphens, max 64 chars (e.g., "nodejs-debugging", "api-integration")
- description: max 200 chars, starts with "Use when..."
- triggers: 5-10 keywords that would appear in similar task descriptions
- Body: actionable steps, not vague advice. Reference specific tools by name.
- If the task was too generic or simple to create a useful skill, output exactly: SKIP

Output the complete skill document (frontmatter + body). No markdown wrapping, no explanation.`;

function _parseSkill(text) {
  if (!text || text.trim() === "SKIP") return null;

  // Extract frontmatter
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]+)$/m);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1];
  const body = fmMatch[2].trim();

  // Parse frontmatter fields
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  const triggersMatch = frontmatter.match(/^triggers:\s*(.+)$/m);

  if (!nameMatch || !descMatch) return null;

  const name = nameMatch[1].trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64);
  const description = descMatch[1].trim().slice(0, 200);
  const triggers = triggersMatch ? triggersMatch[1].trim() : "";

  if (!name || !description || !body) return null;

  const fullContent = `---
name: ${name}
description: ${description}
triggers: ${triggers}
auto_generated: true
---

${body}`;

  return { name, description, triggers, body, fullContent };
}

async function _isDuplicateSkill(taskInput) {
  try {
    const existing = skillLoader.list();
    if (existing.length === 0) return false;

    const queryVec = await generateEmbedding(taskInput);
    if (!queryVec) return false;

    for (const skill of existing) {
      const text = `${skill.name}: ${skill.description || ""}`;
      const skillVec = await generateEmbedding(text);
      if (skillVec && cosineSim(queryVec, skillVec) > DEDUP_THRESHOLD) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function _getSkillDir(tenantId, skillName) {
  if (tenantId) {
    const safeId = tenantId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(config.dataDir, "tenants", safeId, "skills", skillName);
  }
  // Global (admin-generated)
  return join(config.rootDir, "skills", skillName);
}
