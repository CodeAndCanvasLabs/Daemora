import { v4 as uuidv4 } from "uuid";
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { config } from "../config/default.js";

const SESSIONS_DIR = config.sessionsDir;

// Ensure sessions directory exists
mkdirSync(SESSIONS_DIR, { recursive: true });

const sessions = new Map();

export function createSession(existingId = null) {
  const sessionId = existingId || uuidv4();
  const session = {
    sessionId,
    createdAt: new Date().toISOString(),
    messages: [],
  };
  sessions.set(sessionId, session);
  saveSession(session);
  return session;
}

export function getSession(sessionId) {
  // check memory first
  if (sessions.has(sessionId)) {
    return sessions.get(sessionId);
  }

  // fallback: try loading from disk
  const filePath = `${SESSIONS_DIR}/${sessionId}.json`;
  if (existsSync(filePath)) {
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      sessions.set(sessionId, data);
      console.log(`Session ${sessionId} restored from disk`);
      return data;
    } catch (error) {
      console.log(`Failed to restore session ${sessionId}: ${error.message}`);
      return null;
    }
  }

  return null;
}

export function appendMessage(sessionId, role, content) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.messages.push({ role, content, timestamp: new Date().toISOString() });
  saveSession(session);
  return session;
}

export function setMessages(sessionId, messages) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.messages = messages;
  saveSession(session);
  return session;
}

/**
 * List sub-agent session IDs. If prefix given, only returns sessions starting with `{prefix}--`.
 */
export function listSessions(prefix = null) {
  try {
    const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
    let sessionIds = files.map(f => f.slice(0, -5));
    if (prefix) {
      // Return only sub-agent sessions for this parent
      sessionIds = sessionIds.filter(id => id.startsWith(prefix + "--"));
    } else {
      // Exclude sub-agent sessions (contain "--") from top-level listing
      sessionIds = sessionIds.filter(id => !id.includes("--"));
    }
    return sessionIds;
  } catch {
    return [];
  }
}

/**
 * Clear a session — removes messages from memory and deletes file from disk.
 */
export function clearSession(sessionId) {
  let found = false;
  if (sessions.has(sessionId)) {
    sessions.delete(sessionId);
    found = true;
  }
  const filePath = `${SESSIONS_DIR}/${sessionId}.json`;
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    found = true;
  }
  return found;
}

function saveSession(session) {
  const filePath = `${SESSIONS_DIR}/${session.sessionId}.json`;
  writeFileSync(filePath, JSON.stringify(session, null, 2));
}
