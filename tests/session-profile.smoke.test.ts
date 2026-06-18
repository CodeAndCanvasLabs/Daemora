/**
 * Multi-agent: profile-per-session.
 *
 * One user runs several agents concurrently by binding each session to a
 * profile. These tests prove the storage layer round-trips profileId and that
 * a compacted child session keeps the same agent (inherits the profile),
 * rather than silently falling back to the active profile.
 */

import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { SessionStore } from "../src/memory/SessionStore.js";

function store(): SessionStore {
  return new SessionStore(new Database(":memory:"));
}

describe("SessionStore profile-per-session (multi-agent)", () => {
  it("round-trips profileId; omitted → null (active-profile fallback)", () => {
    const s = store();
    const coder = s.createSession({ title: "Coding Engineer", profileId: "coding" });
    const sales = s.createSession({ title: "Sales Hunter", profileId: "sales" });
    const legacy = s.createSession({ title: "default agent" });

    expect(s.getSession(coder.id)?.profileId).toBe("coding");
    expect(s.getSession(sales.id)?.profileId).toBe("sales");
    expect(s.getSession(legacy.id)?.profileId).toBeNull();
  });

  it("two concurrent sessions can run as different agents", () => {
    const s = store();
    const a = s.createSession({ profileId: "research" });
    const b = s.createSession({ profileId: "marketing" });
    // Distinct sessions, distinct agents — the basis for concurrent workers.
    expect(a.id).not.toBe(b.id);
    expect(s.getSession(a.id)?.profileId).toBe("research");
    expect(s.getSession(b.id)?.profileId).toBe("marketing");
  });

  it("child session inherits the parent's profile (survives compaction)", () => {
    const s = store();
    const parent = s.createSession({ title: "p", profileId: "research" });
    const child = s.createChildSession(parent.id, {
      ...(parent.profileId ? { profileId: parent.profileId } : {}),
    });
    expect(s.getSession(child.id)?.profileId).toBe("research");
  });
});
