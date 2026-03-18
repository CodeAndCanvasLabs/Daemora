import { describe, it, expect, afterEach } from "vitest";
import { createSession, getSession, clearSession } from "../../../src/services/sessions.js";
import { run, queryOne, queryAll } from "../../../src/storage/Database.js";

// Track test sessions for cleanup
const testSessions = [];

afterEach(() => {
  // Clean up any test sessions
  for (const id of testSessions) {
    try { clearSession(id); } catch {}
  }
  testSessions.length = 0;
});

describe("sessions", () => {
  it("creates a session", () => {
    const id = `test-session-${Date.now()}`;
    testSessions.push(id);
    createSession(id);
    const session = getSession(id);
    expect(session).toBeTruthy();
    expect(session.sessionId).toBe(id);
  });

  it("clearSession deletes session + messages", () => {
    const id = `test-clear-${Date.now()}`;
    testSessions.push(id);
    createSession(id);

    // Add a message
    run("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)", id, "user", "test message");

    const deleted = clearSession(id);
    expect(deleted).toBe(true);

    const session = getSession(id);
    expect(session).toBeNull();

    const msgs = queryAll("SELECT * FROM messages WHERE session_id = ?", id);
    expect(msgs).toHaveLength(0);
  });

  it("clearSession cascade deletes tasks + cost_entries", () => {
    const sessionId = `test-cascade-${Date.now()}`;
    const taskId = `task-${Date.now()}`;
    testSessions.push(sessionId);

    createSession(sessionId);
    run("INSERT INTO tasks (id, session_id, status, type) VALUES (?, ?, 'completed', 'chat')", taskId, sessionId);
    run("INSERT INTO cost_entries (task_id, tenant_id, model_id, input_tokens) VALUES (?, 'test', 'gpt-4', 100)", taskId);

    clearSession(sessionId);

    const task = queryOne("SELECT * FROM tasks WHERE id = ?", taskId);
    expect(task).toBeNull();

    const costs = queryAll("SELECT * FROM cost_entries WHERE task_id = ?", taskId);
    expect(costs).toHaveLength(0);
  });

  it("clearSession returns false for unknown session", () => {
    expect(clearSession("nonexistent-session-xyz")).toBe(false);
  });
});
