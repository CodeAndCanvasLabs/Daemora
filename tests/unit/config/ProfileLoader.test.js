import { describe, it, expect } from "vitest";
import { getProfile, listProfiles } from "../../../src/config/ProfileLoader.js";

describe("ProfileLoader", () => {
  it("loads built-in profiles", () => {
    const profiles = listProfiles();
    expect(profiles.length).toBeGreaterThan(0);
  });

  it("has coder profile with expected tools", () => {
    const coder = getProfile("coder");
    expect(coder).toBeTruthy();
    expect(coder.name).toBeTruthy();
    expect(coder.tools).toContain("readFile");
    expect(coder.tools).toContain("writeFile");
    expect(coder.tools).toContain("executeCommand");
  });

  it("has researcher profile", () => {
    const researcher = getProfile("researcher");
    expect(researcher).toBeTruthy();
    expect(researcher.tools).toContain("webSearch");
    expect(researcher.tools).toContain("webFetch");
  });

  it("has meeting-attendant profile", () => {
    const meeting = getProfile("meeting-attendant");
    expect(meeting).toBeTruthy();
    expect(meeting.tools).toContain("meetingAction");
  });

  it("returns null for unknown profile", () => {
    expect(getProfile("nonexistent-profile-xyz")).toBeNull();
  });

  it("profile has required fields", () => {
    const profiles = listProfiles();
    for (const p of profiles) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(Array.isArray(p.tools)).toBe(true);
    }
  });
});
