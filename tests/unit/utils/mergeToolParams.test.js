import { describe, it, expect } from "vitest";
import { mergeLegacyParams, mergeLegacyOptions } from "../../../src/utils/mergeToolParams.js";

describe("mergeToolParams", () => {
  describe("mergeLegacyParams", () => {
    it("merges legacy JSON string params with flat fields", () => {
      const result = mergeLegacyParams({
        action: "join",
        params: '{"dialIn": "+1234567890"}',
        pin: "123456",
      });
      expect(result.dialIn).toBe("+1234567890");
      expect(result.pin).toBe("123456");
      expect(result.action).toBeUndefined(); // excluded
      expect(result.params).toBeUndefined(); // excluded
    });

    it("handles no legacy params", () => {
      const result = mergeLegacyParams({ action: "list", id: "abc" });
      expect(result.id).toBe("abc");
      expect(result.action).toBeUndefined();
    });

    it("flat fields override legacy", () => {
      const result = mergeLegacyParams({
        params: '{"key": "old"}',
        key: "new",
      });
      expect(result.key).toBe("new");
    });

    it("handles object params (not string)", () => {
      const result = mergeLegacyParams({
        action: "test",
        params: { nested: true },
      });
      expect(result.nested).toBe(true);
    });

    it("handles null/undefined input", () => {
      expect(mergeLegacyParams(null)).toEqual({});
      expect(mergeLegacyParams(undefined)).toEqual({});
    });
  });

  describe("mergeLegacyOptions", () => {
    it("merges options JSON with flat fields", () => {
      const result = mergeLegacyOptions({
        field: "value",
        options: '{"extra": true}',
      }, ["field"]);
      expect(result.extra).toBe(true);
      expect(result.field).toBeUndefined(); // excluded via topLevelKeys
    });

    it("handles no options", () => {
      const result = mergeLegacyOptions({ key: "val" }, []);
      expect(result.key).toBe("val");
    });
  });
});
