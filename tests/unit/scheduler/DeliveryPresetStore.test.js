import { describe, it, expect, beforeEach } from "vitest";
import {
  savePreset,
  loadPreset,
  loadPresetByName,
  listPresets,
  deletePreset,
} from "../../../src/scheduler/DeliveryPresetStore.js";

describe("DeliveryPresetStore", () => {
  const testPreset = {
    name: `test-preset-${Date.now()}`,
    description: "Test delivery preset",
    targets: [
      { tenantId: "telegram:123", channel: "telegram", userId: "123" },
      { tenantId: null, channel: "email", userId: null },
    ],
  };

  let savedId;

  beforeEach(() => {
    // Save a test preset
    const result = savePreset(testPreset);
    savedId = result.id;
  });

  it("saves and loads a preset by ID", () => {
    const loaded = loadPreset(savedId);
    expect(loaded).toBeTruthy();
    expect(loaded.name).toBe(testPreset.name);
    expect(loaded.targets).toHaveLength(2);
    expect(loaded.targets[0].tenantId).toBe("telegram:123");
  });

  it("loads by name (case-insensitive)", () => {
    const loaded = loadPresetByName(testPreset.name.toUpperCase());
    expect(loaded).toBeTruthy();
    expect(loaded.id).toBe(savedId);
  });

  it("returns null for unknown preset", () => {
    expect(loadPreset("nonexistent")).toBeNull();
    expect(loadPresetByName("nonexistent")).toBeNull();
  });

  it("lists all presets", () => {
    const all = listPresets();
    expect(all.length).toBeGreaterThanOrEqual(1);
    const found = all.find(p => p.id === savedId);
    expect(found).toBeTruthy();
  });

  it("deletes a preset", () => {
    deletePreset(savedId);
    expect(loadPreset(savedId)).toBeNull();
  });

  it("updates an existing preset", () => {
    savePreset({ id: savedId, name: testPreset.name, description: "Updated", targets: [] });
    const loaded = loadPreset(savedId);
    expect(loaded.description).toBe("Updated");
    expect(loaded.targets).toHaveLength(0);
  });
});
