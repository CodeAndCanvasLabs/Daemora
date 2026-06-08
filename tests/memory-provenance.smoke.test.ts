/**
 * Cross-agent context sharing — memory provenance.
 *
 * A user's agents share one memory store. Each entry is tagged with the agent
 * that wrote it (NULL = shared/visible to all). Recall can scope to
 * "mine + shared" so a user's agents share context, while a peer agent's
 * private notes stay private. Memory is DATA, never instructions (threat T3).
 */

import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { MemoryStore } from "../src/memory/MemoryStore.js";

function store(): MemoryStore {
  return new MemoryStore(new Database(":memory:"));
}

describe("MemoryStore provenance (cross-agent context sharing)", () => {
  it("round-trips agentId; omitted → null (shared)", () => {
    const s = store();
    const mine = s.save({ content: "alice prefers pnpm", agentId: "agent-a" });
    const shared = s.save({ content: "shared fact for everyone" });
    expect(s.getById(mine.id)?.agentId).toBe("agent-a");
    expect(s.getById(shared.id)?.agentId).toBeNull();
  });

  it("recall scopes to mine + shared (peer's private entries hidden)", () => {
    const s = store();
    s.save({ content: "private alpha note", agentId: "agent-a" });
    s.save({ content: "private beta note", agentId: "agent-b" });
    s.save({ content: "shared note for all" }); // shared (NULL)

    const aHits = s.search("note", { agentId: "agent-a" });
    const contents = aHits.map((h) => h.content);
    expect(aHits.every((h) => h.agentId === "agent-a" || h.agentId === null)).toBe(true);
    expect(contents).toContain("private alpha note");
    expect(contents).toContain("shared note for all");
    expect(contents).not.toContain("private beta note");
  });

  it("recall without agentId returns all (legacy behaviour)", () => {
    const s = store();
    s.save({ content: "x note one", agentId: "agent-a" });
    s.save({ content: "x note two", agentId: "agent-b" });
    expect(s.search("note").length).toBe(2);
  });
});
