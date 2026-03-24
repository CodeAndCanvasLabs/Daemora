/**
 * VoiceCloneManager - ElevenLabs voice cloning API integration.
 *
 * Upload voice samples → create instant or professional clones.
 * List, delete, and manage cloned voices.
 * Stores voice_id mappings per tenant in SQLite config_entries.
 *
 * Requires ELEVENLABS_API_KEY.
 */

import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import tenantContext from "../tenants/TenantContext.js";
import { queryOne, run, queryAll } from "../storage/Database.js";

const ELEVENLABS_API = "https://api.elevenlabs.io/v1";
const MAX_SAMPLES = 25;
const ALLOWED_AUDIO_EXTENSIONS = [".mp3", ".wav", ".ogg", ".flac", ".m4a", ".webm", ".aac"];

// ── API key resolution ────────────────────────────────────────────────────

function _getApiKey() {
  const store = tenantContext.getStore();
  const tenantKeys = store?.apiKeys || {};
  const key = tenantKeys.ELEVENLABS_API_KEY || process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is required for voice cloning");
  return key;
}

function _getTenantId() {
  return tenantContext.getStore()?.tenant?.id || null;
}

// ── Voice CRUD ────────────────────────────────────────────────────────────

/**
 * Create an instant voice clone from audio samples.
 * @param {string} name - Voice name
 * @param {string[]} samplePaths - Paths to audio files (1-25 files)
 * @param {object} [opts]
 * @param {string} [opts.description] - Voice description
 * @param {object} [opts.labels] - Voice labels { key: value }
 * @returns {Promise<{voiceId: string, name: string}>}
 */
export async function createClone(name, samplePaths, opts = {}) {
  const apiKey = _getApiKey();

  if (!name || name.trim().length === 0) throw new Error("Voice name is required");
  if (!samplePaths || !Array.isArray(samplePaths) || samplePaths.length === 0) {
    throw new Error("At least one audio sample file is required");
  }
  if (samplePaths.length > MAX_SAMPLES) {
    throw new Error(`Maximum ${MAX_SAMPLES} audio samples allowed`);
  }

  // Validate sample files exist and have valid extensions
  for (const path of samplePaths) {
    if (!existsSync(path)) throw new Error(`Sample file not found: ${path}`);
    const ext = basename(path).toLowerCase().match(/\.[^.]+$/)?.[0];
    if (!ext || !ALLOWED_AUDIO_EXTENSIONS.includes(ext)) {
      throw new Error(`Unsupported audio format: ${path}. Allowed: ${ALLOWED_AUDIO_EXTENSIONS.join(", ")}`);
    }
  }

  // Build multipart form data
  const formData = new FormData();
  formData.append("name", name.trim());
  if (opts.description) formData.append("description", opts.description);
  if (opts.labels) formData.append("labels", JSON.stringify(opts.labels));

  for (const path of samplePaths) {
    const buffer = readFileSync(path);
    const fileName = basename(path);
    const blob = new Blob([buffer], { type: _getMimeType(fileName) });
    formData.append("files", blob, fileName);
  }

  const res = await fetch(`${ELEVENLABS_API}/voices/add`, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: formData,
    signal: AbortSignal.timeout(120000), // 2 min for upload
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs voice clone failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const voiceId = data.voice_id;

  // Store voice_id mapping for this tenant
  _storeVoiceMapping(voiceId, name);

  console.log(`[VoiceClone] Created voice "${name}" (${voiceId}) from ${samplePaths.length} sample(s)`);
  return { voiceId, name };
}

/**
 * List all voices (default + cloned) from ElevenLabs account.
 * @returns {Promise<Array<{voiceId: string, name: string, category: string, labels: object}>>}
 */
export async function listVoices() {
  const apiKey = _getApiKey();

  const res = await fetch(`${ELEVENLABS_API}/voices`, {
    headers: { "xi-api-key": apiKey },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs list voices failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return (data.voices || []).map(v => ({
    voiceId: v.voice_id,
    name: v.name,
    category: v.category || "unknown",
    labels: v.labels || {},
    description: v.description || "",
    previewUrl: v.preview_url || null,
    isCloned: v.category === "cloned" || v.category === "professional",
  }));
}

/**
 * Delete a cloned voice.
 * @param {string} voiceId
 * @returns {Promise<{deleted: boolean, voiceId: string}>}
 */
export async function deleteVoice(voiceId) {
  const apiKey = _getApiKey();

  if (!voiceId) throw new Error("voiceId is required");

  const res = await fetch(`${ELEVENLABS_API}/voices/${voiceId}`, {
    method: "DELETE",
    headers: { "xi-api-key": apiKey },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs delete voice failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }

  // Remove from tenant mapping
  _removeVoiceMapping(voiceId);

  console.log(`[VoiceClone] Deleted voice ${voiceId}`);
  return { deleted: true, voiceId };
}

/**
 * Get voice settings (stability, similarity_boost, etc.)
 * @param {string} voiceId
 * @returns {Promise<object>}
 */
export async function getVoiceSettings(voiceId) {
  const apiKey = _getApiKey();

  const res = await fetch(`${ELEVENLABS_API}/voices/${voiceId}/settings`, {
    headers: { "xi-api-key": apiKey },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs get voice settings failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }

  return await res.json();
}

/**
 * Update voice settings.
 * @param {string} voiceId
 * @param {object} settings - { stability, similarity_boost, style, use_speaker_boost }
 */
export async function updateVoiceSettings(voiceId, settings) {
  const apiKey = _getApiKey();

  const res = await fetch(`${ELEVENLABS_API}/voices/${voiceId}/settings/edit`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(settings),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs update voice settings failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }

  return { updated: true, voiceId };
}

/**
 * Get voice info (detailed).
 * @param {string} voiceId
 * @returns {Promise<object>}
 */
export async function getVoice(voiceId) {
  const apiKey = _getApiKey();

  const res = await fetch(`${ELEVENLABS_API}/voices/${voiceId}`, {
    headers: { "xi-api-key": apiKey },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs get voice failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }

  const v = await res.json();
  return {
    voiceId: v.voice_id,
    name: v.name,
    category: v.category,
    description: v.description,
    labels: v.labels,
    settings: v.settings,
    samples: (v.samples || []).map(s => ({
      sampleId: s.sample_id,
      fileName: s.file_name,
      size: s.size_bytes,
    })),
  };
}

/**
 * List cloned voices stored for the current tenant.
 * @returns {Array<{voiceId: string, name: string}>}
 */
export function listTenantVoices() {
  const tenantId = _getTenantId();
  const key = tenantId ? `voice_clones:${tenantId}` : "voice_clones";

  const row = queryOne("SELECT value FROM config_entries WHERE key = $key", { $key: key });
  if (!row) return [];

  try {
    return JSON.parse(row.value);
  } catch {
    return [];
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────

function _storeVoiceMapping(voiceId, name) {
  const tenantId = _getTenantId();
  const key = tenantId ? `voice_clones:${tenantId}` : "voice_clones";

  const existing = listTenantVoices();
  existing.push({ voiceId, name, createdAt: new Date().toISOString() });

  run(
    "INSERT OR REPLACE INTO config_entries (key, value) VALUES ($key, $val)",
    { $key: key, $val: JSON.stringify(existing) }
  );
}

function _removeVoiceMapping(voiceId) {
  const tenantId = _getTenantId();
  const key = tenantId ? `voice_clones:${tenantId}` : "voice_clones";

  const existing = listTenantVoices();
  const filtered = existing.filter(v => v.voiceId !== voiceId);

  if (filtered.length > 0) {
    run(
      "INSERT OR REPLACE INTO config_entries (key, value) VALUES ($key, $val)",
      { $key: key, $val: JSON.stringify(filtered) }
    );
  } else {
    run("DELETE FROM config_entries WHERE key = $key", { $key: key });
  }
}

function _getMimeType(filename) {
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0];
  const mimeMap = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".webm": "audio/webm",
    ".aac": "audio/aac",
  };
  return mimeMap[ext] || "application/octet-stream";
}
