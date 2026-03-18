import { describe, it, expect, vi } from "vitest";
import eventBus from "../../../src/core/EventBus.js";

describe("EventBus", () => {
  it("emits and receives events", () => {
    const handler = vi.fn();
    eventBus.on("test:event", handler);
    eventBus.emitEvent("test:event", { data: "hello" });
    expect(handler).toHaveBeenCalled();
    const payload = handler.mock.calls[0][0];
    expect(payload.data).toBe("hello");
    expect(payload.event).toBe("test:event");
    expect(payload.timestamp).toBeTruthy();
    eventBus.off("test:event", handler);
  });

  it("supports multiple listeners", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    eventBus.on("test:multi", h1);
    eventBus.on("test:multi", h2);
    eventBus.emitEvent("test:multi", {});
    expect(h1).toHaveBeenCalled();
    expect(h2).toHaveBeenCalled();
    eventBus.off("test:multi", h1);
    eventBus.off("test:multi", h2);
  });

  it("off removes listener", () => {
    const handler = vi.fn();
    eventBus.on("test:off", handler);
    eventBus.off("test:off", handler);
    eventBus.emitEvent("test:off", {});
    expect(handler).not.toHaveBeenCalled();
  });
});
