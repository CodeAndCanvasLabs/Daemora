import { describe, it, expect } from "vitest";
import { createTask, startTask, completeTask, failTask } from "../../../src/core/Task.js";

describe("Task", () => {
  describe("createTask", () => {
    it("creates a task with default values", () => {
      const task = createTask({ input: "hello world" });
      expect(task.id).toBeDefined();
      expect(task.status).toBe("pending");
      expect(task.input).toBe("hello world");
      expect(task.channel).toBe("http");
      expect(task.priority).toBe(5);
      expect(task.model).toBeNull();
      expect(task.maxCost).toBeNull();
      expect(task.approvalMode).toBe("auto");
      expect(task.result).toBeNull();
      expect(task.error).toBeNull();
      expect(task.cost.inputTokens).toBe(0);
      expect(task.cost.outputTokens).toBe(0);
      expect(task.cost.estimatedCost).toBe(0);
      expect(task.cost.modelCalls).toBe(0);
      expect(task.toolCalls).toEqual([]);
      expect(task.createdAt).toBeDefined();
      expect(task.startedAt).toBeNull();
      expect(task.completedAt).toBeNull();
    });

    it("accepts channel and channelMeta overrides", () => {
      const task = createTask({
        input: "test",
        channel: "telegram",
        channelMeta: { chatId: 12345 },
        sessionId: "session-abc",
        priority: 1,
        model: "anthropic:claude-sonnet-4-6",
        maxCost: 0.50,
        approvalMode: "every-tool",
      });

      expect(task.channel).toBe("telegram");
      expect(task.channelMeta).toEqual({ chatId: 12345 });
      expect(task.sessionId).toBe("session-abc");
      expect(task.priority).toBe(1);
      expect(task.model).toBe("anthropic:claude-sonnet-4-6");
      expect(task.maxCost).toBe(0.50);
      expect(task.approvalMode).toBe("every-tool");
    });

    it("generates unique IDs for each task", () => {
      const t1 = createTask({ input: "a" });
      const t2 = createTask({ input: "b" });
      expect(t1.id).not.toBe(t2.id);
    });
  });

  describe("startTask", () => {
    it("transitions task to running state", () => {
      const task = createTask({ input: "test" });
      expect(task.status).toBe("pending");
      const result = startTask(task);
      expect(result.status).toBe("running");
      expect(result.startedAt).toBeDefined();
    });

    it("mutates the task in-place", () => {
      const task = createTask({ input: "test" });
      const returned = startTask(task);
      expect(returned).toBe(task); // same reference
    });
  });

  describe("completeTask", () => {
    it("transitions task to completed state", () => {
      const task = createTask({ input: "test" });
      startTask(task);
      const result = completeTask(task, "Done!");
      expect(result.status).toBe("completed");
      expect(result.result).toBe("Done!");
      expect(result.completedAt).toBeDefined();
    });
  });

  describe("failTask", () => {
    it("transitions task to failed state", () => {
      const task = createTask({ input: "test" });
      startTask(task);
      const result = failTask(task, "Something went wrong");
      expect(result.status).toBe("failed");
      expect(result.error).toBe("Something went wrong");
      expect(result.completedAt).toBeDefined();
    });
  });
});
