/**
 * SmartRecall - intelligent memory retrieval for system prompt injection.
 *
 * Replaces the old renderMemorySection (dump all) + renderSemanticRecall (top 5 cosine).
 * Uses composite scoring: similarity × 0.4 + recency × 0.2 + projectMatch × 0.2 + confidence × 0.1 + frequency × 0.1
 *
 * Budget allocation by layer:
 * - Semantic (preferences/corrections): up to 8 entries
 * - Procedural (how-to): up to 5 entries
 * - Episodic (what happened): up to 3 entries
 */

import { generateEmbedding, cosineSim, getEmbeddingProvider } from "../utils/Embeddings.js";
import { queryAll, run } from "../storage/Database.js";

const BUDGET = { semantic: 8, procedural: 5, episodic: 3 };
const MIN_SCORE = 0.30;

/**
 * Recall relevant memories for a task, formatted for system prompt injection.
 * @param {string} taskInput - User's task input
 * @param {object} options - { project }
 * @returns {Promise<string|null>} Formatted memory section or null
 */
export async function recallMemories(taskInput, options = {}) {
  if (!taskInput || taskInput.length < 10) return null;

  const { project } = options;

  try {
    // Get all active memories
    const memories = queryAll(
      `SELECT id, content, category, memory_type, confidence, project, access_count, last_accessed, created_at
       FROM memory_entries
       WHERE superseded_by IS NULL AND confidence >= 0.2
       ORDER BY id DESC`
    );

    if (memories.length === 0) return null;

    // Score each memory
    const queryVec = await generateEmbedding(taskInput);
    const provider = getEmbeddingProvider();

    // Load embeddings for similarity scoring
    const embeddingMap = new Map();
    if (queryVec) {
      const rows = queryAll(
        "SELECT content, embedding FROM embeddings WHERE provider = $prov",
        { $prov: provider }
      );
      for (const row of rows) {
        try {
          embeddingMap.set(row.content, JSON.parse(row.embedding));
        } catch {}
      }
    }

    const scored = memories.map(m => {
      // Similarity score (0-1)
      let similarity = 0;
      if (queryVec) {
        const vec = embeddingMap.get(m.content);
        if (vec) similarity = Math.max(0, cosineSim(queryVec, vec));
      }

      // Recency score (0-1) — exponential decay, half-life 14 days
      const ageMs = Date.now() - new Date(m.created_at || m.last_accessed).getTime();
      const ageDays = ageMs / 86400000;
      const recency = Math.exp(-0.05 * ageDays);

      // Project match (0, 0.5, or 1)
      let projectMatch = 0.5; // null project = global = moderate match
      if (m.project && project) {
        projectMatch = m.project.toLowerCase() === project.toLowerCase() ? 1.0 : 0.0;
      } else if (!m.project) {
        projectMatch = 0.5; // global memories always somewhat relevant
      }

      // Confidence (0-1)
      const confidence = m.confidence ?? 1.0;

      // Frequency (0-1) — normalized access count
      const frequency = Math.min(1.0, (m.access_count || 0) / 20);

      // Composite score
      const score = (similarity * 0.4) + (recency * 0.2) + (projectMatch * 0.2) + (confidence * 0.1) + (frequency * 0.1);

      return { ...m, score, similarity };
    });

    // Filter by minimum score
    const relevant = scored.filter(m => m.score >= MIN_SCORE);
    if (relevant.length === 0) return null;

    // Sort by score descending
    relevant.sort((a, b) => b.score - a.score);

    // Allocate by layer with budget
    const selected = [];
    const counts = { semantic: 0, procedural: 0, episodic: 0 };

    for (const m of relevant) {
      const layer = m.memory_type || "semantic";
      const budget = BUDGET[layer] || 3;
      if ((counts[layer] || 0) < budget) {
        selected.push(m);
        counts[layer] = (counts[layer] || 0) + 1;
      }
      if (selected.length >= 16) break; // hard cap
    }

    if (selected.length === 0) return null;

    // Update access stats (non-blocking)
    const now = new Date().toISOString();
    for (const m of selected) {
      try {
        run(
          "UPDATE memory_entries SET access_count = access_count + 1, last_accessed = $now WHERE id = $id",
          { $now: now, $id: m.id }
        );
      } catch {}
    }

    // Format for system prompt
    return _formatForPrompt(selected);
  } catch (err) {
    console.log(`[SmartRecall] Error (non-fatal): ${err.message}`);
    return null;
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

function _formatForPrompt(memories) {
  const semantic = memories.filter(m => (m.memory_type || "semantic") === "semantic");
  const procedural = memories.filter(m => m.memory_type === "procedural");
  const episodic = memories.filter(m => m.memory_type === "episodic");

  const sections = [];

  if (semantic.length > 0) {
    sections.push("### Known Facts & Preferences");
    for (const m of semantic) {
      const tag = m.category && m.category !== "general" ? `[${m.category}] ` : "";
      sections.push(`- ${tag}${m.content}`);
    }
  }

  if (procedural.length > 0) {
    sections.push("\n### Learned Procedures");
    for (const m of procedural) {
      sections.push(`- ${m.content}`);
    }
  }

  if (episodic.length > 0) {
    sections.push("\n### Recent Context");
    for (const m of episodic) {
      sections.push(`- ${m.content}`);
    }
  }

  return `## Agent Memory\n\n${sections.join("\n")}`;
}
