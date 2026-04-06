/**
 * MeetingSessionManager - state machine for meeting sessions.
 *
 * Each session tracks: state, dialIn, participants, transcript.
 * States: idle → joining → active → leaving → left → error
 *
 * Per-session isolation via RequestContext.
 */

import { v4 as uuidv4 } from "uuid";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import eventBus from "../core/EventBus.js";
import requestContext from "../core/RequestContext.js";
import { config } from "../config/default.js";

const MAX_SESSIONS = 5;
const MAX_TRANSCRIPT = 2000; // max transcript entries per session
const SESSION_TIMEOUT = 4 * 60 * 60 * 1000; // 4 hours max

// Valid state transitions
const TRANSITIONS = {
  idle:       ["joining"],
  joining:    ["active", "error", "left"],
  active:     ["leaving", "error", "left"],
  leaving:    ["left", "error"],
  left:       [],
  error:      ["joining", "left"],
};

/** @type {Map<string, MeetingSession>} */
const sessions = new Map();

// ── Auto-cleanup expired sessions ─────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.startedAt > SESSION_TIMEOUT) {
      session.state = "left";
      session.endedAt = now;
      session.error = "Session timed out (4h max)";
      eventBus.emitEvent("meeting:timeout", { sessionId: id });
    }
    // GC sessions left > 30 min ago
    if (session.state === "left" && session.endedAt && now - session.endedAt > 30 * 60 * 1000) {
      sessions.delete(id);
    }
  }
}, 60 * 1000);

// ── Platform detection ────────────────────────────────────────────────────

function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes("zoom.us") || u.includes("zoom.com")) return "zoom";
  if (u.includes("meet.google.com")) return "meet";
  if (u.includes("teams.microsoft.com") || u.includes("teams.live.com")) return "teams";
  return "generic";
}

// ── Tenant scoping ────────────────────────────────────────────────────────

function _getSessionScope() {
  return requestContext.getStore()?.sessionId || "__global__";
}

function _countActiveSessions() {
  const scope = _getSessionScope();
  let count = 0;
  for (const s of sessions.values()) {
    if (s.scope === scope && !["left", "error"].includes(s.state)) count++;
  }
  return count;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Create a new meeting session.
 * @param {string} dialIn - Meeting dial-in phone number (or meeting URL for display)
 * @param {object} opts
 * @param {string} [opts.displayName] - Bot display name
 * @param {string} [opts.pin] - Meeting PIN
 * @param {string} [opts.meetingUrl] - Original meeting URL (for reference)
 * @param {string} [opts.voiceId] - TTS voice ID
 * @returns {MeetingSession}
 */
export function createSession(dialIn, opts = {}) {
  if (!dialIn) throw new Error("Meeting dial-in number is required");

  if (_countActiveSessions() >= MAX_SESSIONS) {
    throw new Error(`Maximum ${MAX_SESSIONS} active meeting sessions. Leave one first.`);
  }

  const id = uuidv4().slice(0, 8);
  const scope = _getSessionScope();
  const platform = detectPlatform(opts.meetingUrl || dialIn);

  const session = {
    id,
    dialIn,
    meetingUrl: opts.meetingUrl || dialIn,
    platform,
    state: "idle",
    scope,
    displayName: opts.displayName || "Daemora",
    pin: opts.pin || "",
    participants: new Map(),
    transcript: [],
    voiceId: opts.voiceId || null,
    startedAt: Date.now(),
    endedAt: null,
    error: null,
    muted: false,
  };

  sessions.set(id, session);
  eventBus.emitEvent("meeting:created", { sessionId: id, platform, dialIn });
  console.log(`[Meeting] Created session ${id} (${platform}) → ${dialIn}`);
  return _serialize(session);
}

/**
 * Get a session by ID (tenant-scoped).
 */
export function getSession(id) {
  const session = sessions.get(id);
  if (!session) return null;
  if (session.scope !== _getSessionScope()) return null;
  return _serialize(session);
}

/**
 * Get raw session (internal use - not tenant-scoped).
 */
export function _getRawSession(id) {
  return sessions.get(id) || null;
}

/**
 * List all active sessions for current tenant.
 */
export function listSessions() {
  const scope = _getSessionScope();
  return [...sessions.values()]
    .filter(s => s.scope === scope)
    .map(_serialize);
}

/**
 * Update session state with transition validation.
 */
export function updateState(id, newState, error = null) {
  const session = sessions.get(id);
  if (!session) throw new Error(`Session "${id}" not found`);

  const allowed = TRANSITIONS[session.state];
  if (!allowed || !allowed.includes(newState)) {
    throw new Error(`Invalid transition: ${session.state} → ${newState}`);
  }

  const oldState = session.state;
  session.state = newState;
  if (error) session.error = error;
  if (newState === "left" || newState === "error") session.endedAt = Date.now();

  eventBus.emitEvent("meeting:state", { sessionId: id, from: oldState, to: newState, error });
  console.log(`[Meeting] Session ${id}: ${oldState} → ${newState}${error ? ` (${error})` : ""}`);
}

/**
 * Add a transcript entry.
 */
export function addTranscript(id, entry) {
  const session = sessions.get(id);
  if (!session) return;
  const transcriptEntry = {
    speaker: entry.speaker || "unknown",
    text: entry.text,
    timestamp: Date.now(),
  };

  // Dedup - skip if same text within 2 seconds of last entry
  const last = session.transcript[session.transcript.length - 1];
  if (last && last.text === transcriptEntry.text && (transcriptEntry.timestamp - last.timestamp) < 2000) {
    return; // duplicate
  }

  session.transcript.push(transcriptEntry);

  // Persist to disk (JSONL - one JSON object per line, survives restarts)
  try {
    if (!session._transcriptPath) {
      const dir = join(config.dataDir, "meetings");
      mkdirSync(dir, { recursive: true });
      session._transcriptPath = join(dir, `transcript-${id}.jsonl`);
    }
    appendFileSync(session._transcriptPath, JSON.stringify(transcriptEntry) + "\n");
  } catch {}

  // Cap in-memory transcript
  if (session.transcript.length > MAX_TRANSCRIPT) {
    session.transcript = session.transcript.slice(-MAX_TRANSCRIPT);
  }
}

/**
 * Update participants list.
 */
export function updateParticipants(id, participants) {
  const session = sessions.get(id);
  if (!session) return;
  session.participants.clear();
  for (const p of participants) {
    session.participants.set(p.id || p.name, { name: p.name, joinedAt: p.joinedAt || Date.now() });
  }
}

/**
 * Set mute state.
 */
export function setMuted(id, muted) {
  const session = sessions.get(id);
  if (!session) throw new Error(`Session "${id}" not found`);
  session.muted = muted;
}

/**
 * Cleanup a session.
 */
export function cleanup(id) {
  const session = sessions.get(id);
  if (!session) return;

  if (session.state !== "left" && session.state !== "error") {
    session.state = "left";
    session.endedAt = Date.now();
  }

  console.log(`[Meeting] Cleaned up session ${id}`);
}

// ── Serialization ─────────────────────────────────────────────────────────

function _serialize(session) {
  return {
    id: session.id,
    dialIn: session.dialIn,
    meetingUrl: session.meetingUrl,
    platform: session.platform,
    state: session.state,
    displayName: session.displayName,
    participantCount: session.participants.size,
    participants: [...session.participants.values()],
    transcriptCount: session.transcript.length,
    transcript: session.transcript,
    startedAt: new Date(session.startedAt).toISOString(),
    endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : null,
    error: session.error,
    muted: session.muted,
  };
}
