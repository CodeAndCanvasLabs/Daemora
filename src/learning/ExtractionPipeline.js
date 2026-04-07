/**
 * ExtractionPipeline - automatic memory extraction from completed conversations.
 *
 * Two direct generateText() calls — no agent loop, no tools, no hoping the model cooperates.
 *
 * Stage 1: extractMemories() — LLM extracts atomic facts as JSON
 * Stage 2: manageMemories() — LLM compares against existing, decides ADD/UPDATE/SUPERSEDE/SKIP
 *
 * Cost: ~$0.001 per extraction (2 cheap model calls) vs $0.02 (old sub-agent)
 */

import { generateText } from "ai";
import { getCheapModel } from "../models/ModelRouter.js";
import { generateEmbedding, cosineSim } from "../utils/Embeddings.js";
import { queryAll, run, transaction } from "../storage/Database.js";
import { FACT_EXTRACTION_PROMPT, MEMORY_MANAGEMENT_PROMPT } from "./prompts.js";
import { logLearning, incrementStats } from "./LearningStats.js";
import { v4 as uuidv4 } from "uuid";

// ── Stage 1: Extract facts from conversation ────────────────────────────────

/**
 * Extract atomic facts from a completed conversation.
 * @param {Array} messages - Cleaned conversation messages [{role, content}]
 * @param {string} taskId
 * @returns {Promise<{facts: Array, modelId: string, usage: object, latencyMs: number}>}
 */
export async function extractMemories(messages, taskId) {
  const { model, modelId } = getCheapModel();

  const conversationText = messages
    .map(m => `[${m.role}]: ${m.content}`)
    .join("\n");

  const startMs = Date.now();
  const { text, usage } = await generateText({
    model,
    maxTokens: 1024,
    temperature: 0,
    system: FACT_EXTRACTION_PROMPT,
    prompt: conversationText,
  });

  const latencyMs = Date.now() - startMs;
  const facts = _parseJSON(text) || [];

  logLearning(taskId, "extraction", facts.length > 0 ? "extracted" : "noop", {
    factCount: facts.length, modelId,
    inputTokens: usage?.totalTokens?.input || 0,
    outputTokens: usage?.totalTokens?.output || 0,
    latencyMs,
  });

  return { facts, modelId, usage, latencyMs };
}

// ── Stage 2: Manage facts against existing memory ───────────────────────────

/**
 * For each extracted fact, compare against existing memories and decide action.
 * @param {Array} facts - From extractMemories()
 * @param {string} taskId
 * @returns {Promise<Array>} decisions with actions taken
 */
export async function manageMemories(facts, taskId) {
  if (!facts || facts.length === 0) return [];

  // Retrieve relevant existing memories for comparison
  const existingMemories = await _getRelevantExisting(facts);

  if (existingMemories.length === 0) {
    // No existing memories — ADD all facts directly, skip LLM call 2
    const decisions = [];
    transaction(() => {
      for (let i = 0; i < facts.length; i++) {
        const fact = facts[i];
        const id = _insertMemory(fact, taskId);
        decisions.push({ fact_index: i, action: "ADD", memory_id: id });
        incrementStats("memories_added");
        logLearning(taskId, "memory", "add", { memoryId: id, content: fact.content?.slice(0, 100) });
      }
    });
    return decisions;
  }

  // Build prompt with existing memories for comparison
  const { model, modelId } = getCheapModel();
  const startMs = Date.now();

  const existingFormatted = existingMemories.map((m, i) => (
    `[${i}] id=${m.id} layer=${m.memory_type || "semantic"} cat=${m.category} — ${m.content}`
  )).join("\n");

  const factsFormatted = facts.map((f, i) => (
    `[${i}] layer=${f.layer} cat=${f.category} conf=${f.confidence} — ${f.content}`
  )).join("\n");

  const { text, usage } = await generateText({
    model,
    modelId,
    maxTokens: 1024,
    temperature: 0,
    system: MEMORY_MANAGEMENT_PROMPT,
    prompt: `EXISTING MEMORIES:\n${existingFormatted}\n\nNEW FACTS:\n${factsFormatted}`,
  });

  const latencyMs = Date.now() - startMs;
  const rawDecisions = _parseJSON(text) || [];

  // Execute decisions
  const decisions = [];
  transaction(() => {
    for (const d of rawDecisions) {
      const fact = facts[d.fact_index];
      if (!fact) continue;

      switch (d.action) {
        case "ADD": {
          const id = _insertMemory(fact, taskId);
          decisions.push({ ...d, memory_id: id });
          incrementStats("memories_added");
          logLearning(taskId, "memory", "add", { memoryId: id, content: fact.content?.slice(0, 100) });
          break;
        }
        case "UPDATE": {
          if (d.existing_id) {
            run(
              "UPDATE memory_entries SET content = $content, confidence = $conf, updated_at = datetime('now') WHERE id = $id",
              { $content: fact.content, $conf: fact.confidence || 1.0, $id: d.existing_id }
            );
            decisions.push({ ...d, memory_id: d.existing_id });
            incrementStats("memories_updated");
            logLearning(taskId, "memory", "update", { memoryId: d.existing_id, content: fact.content?.slice(0, 100) });
          }
          break;
        }
        case "SUPERSEDE": {
          if (d.existing_id) {
            // Mark old memory as superseded
            const newId = _insertMemory(fact, taskId);
            run(
              "UPDATE memory_entries SET superseded_by = $newId WHERE id = $oldId",
              { $newId: newId, $oldId: d.existing_id }
            );
            decisions.push({ ...d, memory_id: newId });
            incrementStats("memories_superseded");
            logLearning(taskId, "memory", "supersede", { memoryId: newId, superseded: d.existing_id, content: fact.content?.slice(0, 100) });
          }
          break;
        }
        case "SKIP":
        default:
          decisions.push({ ...d, memory_id: null });
          break;
      }
    }
  });

  logLearning(taskId, "management", "complete", {
    modelId,
    inputTokens: usage?.totalTokens?.input || 0,
    outputTokens: usage?.totalTokens?.output || 0,
    latencyMs,
    adds: decisions.filter(d => d.action === "ADD").length,
    updates: decisions.filter(d => d.action === "UPDATE").length,
    supersedes: decisions.filter(d => d.action === "SUPERSEDE").length,
  });

  return decisions;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _insertMemory(fact, taskId) {
  const id = uuidv4().slice(0, 12);
  const now = new Date().toISOString();
  run(
    `INSERT INTO memory_entries (id, content, category, memory_type, confidence, project, source_task_id, timestamp, created_at)
     VALUES ($id, $content, $cat, $type, $conf, $proj, $taskId, $ts, $ts)`,
    {
      $id: id,
      $content: fact.content,
      $cat: fact.category || "general",
      $type: fact.layer || "semantic",
      $conf: fact.confidence ?? 1.0,
      $proj: fact.project || null,
      $taskId: taskId || null,
      $ts: now,
    }
  );

  // Index embedding async (non-blocking)
  _indexEmbedding(id, fact.content, fact.category, fact.layer).catch(() => {});

  return id;
}

async function _indexEmbedding(memoryId, content, category, layer) {
  const vector = await generateEmbedding(content);
  if (!vector) return;

  const { getEmbeddingProvider } = await import("../utils/Embeddings.js");
  const provider = getEmbeddingProvider();

  run(
    `INSERT INTO embeddings (content, embedding, source, category, provider, created_at)
     VALUES ($content, $emb, $source, $cat, $prov, datetime('now'))`,
    {
      $content: content,
      $emb: JSON.stringify(vector),
      $source: layer || "memory",
      $cat: category || "general",
      $prov: provider,
    }
  );
}

async function _getRelevantExisting(facts) {
  const allContent = facts.map(f => f.content).join(" ");
  const queryVec = await generateEmbedding(allContent);

  if (!queryVec) {
    // Fallback: keyword search
    return queryAll(
      "SELECT id, content, category, memory_type, confidence FROM memory_entries WHERE superseded_by IS NULL ORDER BY id DESC LIMIT 20"
    );
  }

  const { getEmbeddingProvider } = await import("../utils/Embeddings.js");
  const provider = getEmbeddingProvider();

  const rows = queryAll(
    "SELECT id, content, embedding, source, category FROM embeddings WHERE provider = $prov",
    { $prov: provider }
  );

  const scored = [];
  for (const row of rows) {
    try {
      const vec = JSON.parse(row.embedding);
      const sim = cosineSim(queryVec, vec);
      if (sim >= 0.35) {
        // Get the full memory entry
        const mem = queryAll(
          "SELECT id, content, category, memory_type, confidence FROM memory_entries WHERE content = $c AND superseded_by IS NULL LIMIT 1",
          { $c: row.content }
        )[0];
        if (mem) scored.push({ ...mem, score: sim });
      }
    } catch {}
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 10);
}

function _parseJSON(text) {
  if (!text) return null;
  try {
    // Try direct parse
    return JSON.parse(text);
  } catch {
    // Extract JSON from markdown code blocks
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try { return JSON.parse(match[1].trim()); } catch {}
    }
    // Try to find array in text
    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try { return JSON.parse(arrMatch[0]); } catch {}
    }
    // Try to find object in text
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try { return JSON.parse(objMatch[0]); } catch {}
    }
    return null;
  }
}
