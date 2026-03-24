import { v4 as uuidv4 } from "uuid";
import { queryAll, queryOne, run, transaction } from "../storage/Database.js";

export function createSession(existingId = null) {
  const sessionId = existingId || uuidv4();
  const createdAt = new Date().toISOString();
  run(
    "INSERT OR IGNORE INTO sessions (id, created_at, updated_at) VALUES ($id, $ts, $ts)",
    { $id: sessionId, $ts: createdAt }
  );
  return { sessionId, createdAt, messages: [] };
}

export function getSession(sessionId) {
  const row = queryOne("SELECT * FROM sessions WHERE id = $id", { $id: sessionId });
  if (!row) return null;

  const msgs = queryAll(
    "SELECT role, content, created_at FROM messages WHERE session_id = $sid ORDER BY id ASC",
    { $sid: sessionId }
  );

  return {
    sessionId: row.id,
    createdAt: row.created_at,
    messages: msgs.map(m => ({
      role: m.role,
      content: _parseContent(m.content),
      timestamp: m.created_at,
    })),
  };
}

export function appendMessage(sessionId, role, content) {
  const session = queryOne("SELECT id FROM sessions WHERE id = $id", { $id: sessionId });
  if (!session) return null;

  const ts = new Date().toISOString();
  run(
    "INSERT INTO messages (session_id, role, content, created_at) VALUES ($sid, $role, $content, $ts)",
    {
      $sid: sessionId,
      $role: role,
      $content: typeof content === "string" ? content : JSON.stringify(content),
      $ts: ts,
    }
  );
  run("UPDATE sessions SET updated_at = $ts WHERE id = $id", { $id: sessionId, $ts: ts });

  return getSession(sessionId);
}

export function setMessages(sessionId, messages) {
  const session = queryOne("SELECT id FROM sessions WHERE id = $id", { $id: sessionId });
  if (!session) return null;

  const ts = new Date().toISOString();
  transaction(() => {
    run("DELETE FROM messages WHERE session_id = $sid", { $sid: sessionId });
    for (const msg of messages) {
      run(
        "INSERT INTO messages (session_id, role, content, created_at) VALUES ($sid, $role, $content, $ts)",
        {
          $sid: sessionId,
          $role: msg.role || "user",
          $content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          $ts: msg.timestamp || ts,
        }
      );
    }
    run("UPDATE sessions SET updated_at = $ts WHERE id = $id", { $id: sessionId, $ts: ts });
  });

  return getSession(sessionId);
}

/**
 * List sub-agent session IDs. If prefix given, only returns sessions starting with `{prefix}--`.
 */
export function listSessions(prefix = null) {
  const rows = queryAll("SELECT id FROM sessions ORDER BY created_at DESC");
  let sessionIds = rows.map(r => r.id);
  if (prefix) {
    sessionIds = sessionIds.filter(id => id.startsWith(prefix + "--"));
  } else {
    sessionIds = sessionIds.filter(id => !id.includes("--"));
  }
  return sessionIds;
}

/**
 * Clear a session - removes messages, tasks, cost entries, and session record.
 */
export function clearSession(sessionId) {
  const session = queryOne("SELECT id FROM sessions WHERE id = $id", { $id: sessionId });
  if (!session) return false;
  transaction(() => {
    // Delete cost entries for tasks in this session + sub-sessions
    run(`DELETE FROM cost_entries WHERE task_id IN (
      SELECT id FROM tasks WHERE session_id = $sid OR session_id LIKE $pattern
    )`, { $sid: sessionId, $pattern: `${sessionId}--%` });
    // Delete tasks (main + sub-sessions)
    run("DELETE FROM tasks WHERE session_id = $sid OR session_id LIKE $pattern", { $sid: sessionId, $pattern: `${sessionId}--%` });
    // Delete messages (main + sub-sessions)
    run("DELETE FROM messages WHERE session_id = $sid OR session_id LIKE $pattern", { $sid: sessionId, $pattern: `${sessionId}--%` });
    // Delete sessions (main + sub-sessions: --coder, --crew:system-monitor, --serverName, etc.)
    run("DELETE FROM sessions WHERE id = $id OR id LIKE $pattern", { $id: sessionId, $pattern: `${sessionId}--%` });
  });
  return true;
}

function _parseContent(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object") return parsed;
    return raw;
  } catch {
    return raw;
  }
}
