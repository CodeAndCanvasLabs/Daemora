/**
 * BackgroundReviewer - orchestrates post-task learning.
 *
 * Pipeline (no sub-agent, no tool calls):
 * 1. Threshold check (3+ tool calls, 50+ chars, not cron/watcher)
 * 2. extractMemories() — LLM extracts atomic facts as JSON
 * 3. manageMemories() — LLM compares against existing, decides ADD/UPDATE/SUPERSEDE/SKIP
 * 4. maybeExtractSkill() — For complex tasks (10+ tools), detect reusable procedures
 *
 * Cost: ~$0.001/extraction (vs $0.02 old sub-agent = 20x cheaper, 100x more reliable)
 */

import { extractMemories, manageMemories } from "./ExtractionPipeline.js";
import { logLearning, incrementStats } from "./LearningStats.js";
import { SKILL_EXTRACTION_PROMPT } from "./prompts.js";

// ── Thresholds ──────────────────────────────────────────────────────────────

const MIN_TOOL_CALLS = 3;
const MIN_INPUT_LENGTH = 50;
const SKILL_THRESHOLD = 10;
const GREETING_PATTERN = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|yep|nope|bye|good morning|good evening|gm|gn)\s*[!.?]*$/i;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Run learning extraction if thresholds met.
 * Called post-task from TaskRunner (fire-and-forget).
 */
export async function maybeRunReview(task, result, options = {}) {
  try {
    if (task.type === "watcher" || task.type === "cron" || task.type === "heartbeat") return;
    if (!result.text) return;

    const input = task.input || "";
    if (input.length < MIN_INPUT_LENGTH) return;
    if (GREETING_PATTERN.test(input.trim())) return;

    const toolCallCount = (result.toolCalls || []).length;
    if (toolCallCount < MIN_TOOL_CALLS) return;

    const messages = _buildHistoryMessages(result.messages);
    if (messages.length < 2) return;

    console.log(`[Learning] Extracting from task ${task.id?.slice(0, 8)} (${toolCallCount} tool calls)`);
    incrementStats("extraction_attempts");

    // Stage 1: Extract facts
    const { facts, modelId, latencyMs } = await extractMemories(messages, task.id);

    if (facts.length === 0) {
      console.log(`[Learning] No facts extracted (task ${task.id?.slice(0, 8)})`);
      return;
    }

    incrementStats("facts_extracted", facts.length);
    console.log(`[Learning] Extracted ${facts.length} fact(s) in ${latencyMs}ms using ${modelId}`);

    // Stage 2: Manage facts (compare, dedupe, store)
    const decisions = await manageMemories(facts, task.id);

    const adds = decisions.filter(d => d.action === "ADD").length;
    const updates = decisions.filter(d => d.action === "UPDATE").length;
    const supersedes = decisions.filter(d => d.action === "SUPERSEDE").length;
    const skips = decisions.filter(d => d.action === "SKIP").length;

    console.log(`[Learning] Results: +${adds} added, ~${updates} updated, ⇄${supersedes} superseded, =${skips} skipped`);

    // Stage 3: Skill extraction for complex tasks
    if (toolCallCount >= SKILL_THRESHOLD) {
      await _maybeExtractSkill(messages, result.toolCalls, task.id);
    }
  } catch (err) {
    console.error(`[Learning] Error (non-fatal): ${err.message}`);
    incrementStats("errors");
    logLearning(task?.id, "pipeline", "error", { error: err.message });
  }
}

// ── Skill Extraction ────────────────────────────────────────────────────────

async function _maybeExtractSkill(messages, toolCalls, taskId) {
  try {
    const toolNames = (toolCalls || []).map(tc => tc.tool || tc.name).filter(Boolean);
    const uniqueTools = [...new Set(toolNames)];
    if (uniqueTools.length < 3) return;

    const { generateText } = await import("ai");
    const { getCheapModel } = await import("../models/ModelRouter.js");
    const { model, modelId } = getCheapModel();

    const toolTrace = toolNames.map((t, i) => `${i + 1}. ${t}`).join("\n");
    const conversationText = messages.map(m => `[${m.role}]: ${m.content}`).join("\n");

    const { text } = await generateText({
      model,
      maxTokens: 2048,
      temperature: 0,
      system: SKILL_EXTRACTION_PROMPT,
      prompt: `TOOL TRACE:\n${toolTrace}\n\nCONVERSATION:\n${conversationText}`,
    });

    const result = _parseJSON(text);
    if (!result?.should_save || !result.skill_name || !result.content) return;

    const { existsSync, writeFileSync } = await import("fs");
    const { join } = await import("path");
    const { config } = await import("../config/default.js");

    const skillPath = join(config.skillsDir, `${result.skill_name}.md`);
    if (existsSync(skillPath)) {
      console.log(`[Learning] Skill "${result.skill_name}" already exists — skipping`);
      return;
    }

    const frontmatter = `---\nname: ${result.skill_name}\ndescription: ${result.description || result.skill_name}\ntriggers: ${result.triggers || result.skill_name.replace(/-/g, ", ")}\n---\n\n`;
    writeFileSync(skillPath, frontmatter + result.content);

    // Reload skill cache
    try {
      const skillLoader = (await import("../skills/SkillLoader.js")).default;
      skillLoader.reload();
    } catch {}

    incrementStats("skills_created");
    logLearning(taskId, "skill", "created", { skillName: result.skill_name });
    console.log(`[Learning] Created skill: ${result.skill_name}`);
  } catch (err) {
    console.log(`[Learning] Skill extraction failed (non-fatal): ${err.message}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build clean history messages from the completed conversation.
 * Strips tool-call/result internals — extraction only needs user messages + assistant text.
 * Includes tool names for procedural extraction.
 */
function _buildHistoryMessages(messages) {
  if (!messages || !Array.isArray(messages)) return [];

  const clean = [];
  for (const msg of messages) {
    if (!msg || !msg.role) continue;

    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      if (!text) continue;
      if (text.startsWith("[Supervisor instruction]:")) continue;
      if (text.startsWith("[System:")) continue;
      if (text.startsWith("[User follow-up while you are working")) continue;
      clean.push({ role: "user", content: text.slice(0, 2000) });
    }

    if (msg.role === "assistant") {
      // Include tool call names for procedural extraction
      if (Array.isArray(msg.content)) {
        const toolCalls = msg.content.filter(p => p.type === "tool-call").map(p => p.toolName || p.name);
        const textParts = msg.content.filter(p => p.type === "text").map(p => p.text);
        const combined = [];
        if (toolCalls.length > 0) combined.push(`[Tools: ${toolCalls.join(", ")}]`);
        if (textParts.length > 0) combined.push(textParts.join("\n"));
        if (combined.length > 0) {
          clean.push({ role: "assistant", content: combined.join(" ").slice(0, 2000) });
        }
      } else {
        const text = typeof msg.content === "string" ? msg.content : "";
        if (text) clean.push({ role: "assistant", content: text.slice(0, 2000) });
      }
    }
  }

  return clean.slice(-20);
}

function _parseJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) { try { return JSON.parse(match[1].trim()); } catch {} }
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]); } catch {} }
  return null;
}
