/**
 * discoverProfiles - main agent tool for finding the right sub-agent profile.
 *
 * Uses embeddings to match task description against profile descriptions.
 * Returns matches sorted by relevance.
 *
 * Three-tier fallback:
 *   1. discoverProfiles(query) → top 5
 *   2. discoverProfiles(query, {offset: 5}) → next batch
 *   3. discoverProfiles("*", {all: true}) → everything
 */

import { listProfiles } from "../config/ProfileLoader.js";
import { getRegistry } from "../crew/PluginRegistry.js";

// ── Profile embeddings cache ────────────────────────────────────────────────

let _profileEmbeddings = null; // [{id, name, description, embedding, crew}]
let _embedFn = null;

async function _ensureEmbeddings() {
  if (_profileEmbeddings) return;

  const profiles = listProfiles();
  _profileEmbeddings = [];

  // Try to get embedding function
  try {
    const { embed } = await import("../utils/Embeddings.js");
    _embedFn = embed;

    for (const p of profiles) {
      const text = `${p.name}: ${p.description || ""} ${(p.tools || []).slice(0, 5).join(", ")}`;
      try {
        const embedding = await embed(text);
        _profileEmbeddings.push({
          id: p.id,
          name: p.name,
          description: p.description || "",
          embedding,
          crew: _getProfileCrew(p.id),
        });
      } catch {
        // Embedding failed - store without embedding (keyword fallback)
        _profileEmbeddings.push({
          id: p.id,
          name: p.name,
          description: p.description || "",
          embedding: null,
          crew: _getProfileCrew(p.id),
        });
      }
    }
  } catch {
    // No embedding provider - keyword matching only
    for (const p of profiles) {
      _profileEmbeddings.push({
        id: p.id,
        name: p.name,
        description: p.description || "",
        embedding: null,
        crew: _getProfileCrew(p.id),
      });
    }
  }
}

function _getProfileCrew(profileId) {
  // Check if this profile was loaded by a crew member
  const registry = getRegistry();
  for (const p of registry.crew) {
    if (p.status === "loaded") {
      // Check if crew member's manifest.profiles includes this profile
      const manifest = p.manifest;
      if (manifest?.profiles?.includes(profileId)) {
        return { id: p.id, name: p.name };
      }
    }
  }
  return null; // built-in profile
}

function _cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

function _keywordScore(query, profile) {
  const q = query.toLowerCase();
  const text = `${profile.id} ${profile.name} ${profile.description}`.toLowerCase();
  const words = q.split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return 0;
  let matches = 0;
  for (const w of words) {
    if (text.includes(w)) matches++;
  }
  return matches / words.length;
}

// ── Tool function ───────────────────────────────────────────────────────────

export async function discoverProfiles(params) {
  const query = typeof params === "string" ? params : (params?.query || params?.action || "");
  const limit = params?.limit || 5;
  const offset = params?.offset || 0;
  const all = params?.all === true || query === "*";

  await _ensureEmbeddings();

  if (!_profileEmbeddings || _profileEmbeddings.length === 0) {
    return JSON.stringify({ matches: [], total: 0, disabled: [] });
  }

  // Score all profiles
  let scored;
  if (all) {
    scored = _profileEmbeddings.map(p => ({ ...p, score: 1 }));
  } else {
    // Try embedding-based scoring
    let queryEmbedding = null;
    if (_embedFn) {
      try { queryEmbedding = await _embedFn(query); } catch {}
    }

    scored = _profileEmbeddings.map(p => {
      const embScore = queryEmbedding && p.embedding
        ? _cosineSimilarity(queryEmbedding, p.embedding)
        : 0;
      const kwScore = _keywordScore(query, p);
      return { ...p, score: Math.max(embScore, kwScore) };
    });

    scored.sort((a, b) => b.score - a.score);
  }

  const matches = scored.map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    crew: p.crew?.id || null,
    score: Math.round(p.score * 100) / 100,
    enabled: true,
  }));

  // Apply pagination
  const paginated = matches.slice(offset, offset + limit);
  const total = matches.length;

  return JSON.stringify({ matches: paginated, total, disabled: [] }, null, 2);
}

export const discoverProfilesDescription =
  `discoverProfiles(query, {limit?, offset?, all?}) - Find the right sub-agent profile for a task. Returns matching profiles sorted by relevance. Use before spawnAgent when unsure which profile to use.`;

export function clearProfileEmbeddingsCache() {
  _profileEmbeddings = null;
}
