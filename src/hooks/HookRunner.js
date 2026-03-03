import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { config } from "../config/default.js";
import eventBus from "../core/EventBus.js";

/**
 * Hook Runner - event-driven interception at tool lifecycle points.
 * Inspired by Claude Code's hook system.
 *
 * Supports:
 * - PreToolUse: Before a tool executes. Can block/allow/modify.
 * - PostToolUse: After a tool executes. Can log/warn/react.
 * - TaskStart: When a task begins processing.
 * - TaskEnd: When a task completes.
 * - MemoryWrite: Before writing to memory. Can validate.
 *
 * Hook types:
 * - "command": Run a shell command. Receives env vars TOOL_NAME, TOOL_INPUT, etc.
 * - "js": Run a JavaScript function inline.
 *
 * Hook output: { decision: "allow"|"block"|"ask", reason: string, modifiedInput?: object }
 */

const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "TaskStart",
  "TaskEnd",
  "MemoryWrite",
];

class HookRunner {
  constructor() {
    this.hooks = {};
    this.loaded = false;
  }

  /**
   * Load hooks from config/hooks.json
   */
  load() {
    const hooksPath = join(config.rootDir, "config", "hooks.json");

    if (!existsSync(hooksPath)) {
      // Create default hooks file
      this.hooks = {};
      this.loaded = true;
      console.log(`[HookRunner] No hooks.json found - hooks disabled`);
      return;
    }

    try {
      const raw = readFileSync(hooksPath, "utf-8");
      this.hooks = JSON.parse(raw);
      this.loaded = true;

      const count = Object.values(this.hooks).reduce(
        (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
        0
      );
      console.log(`[HookRunner] Loaded ${count} hooks from hooks.json`);
    } catch (error) {
      console.log(`[HookRunner] Error loading hooks: ${error.message}`);
      this.hooks = {};
      this.loaded = true;
    }
  }

  /**
   * Run all hooks for an event.
   *
   * @param {string} event - Hook event name (e.g., "PreToolUse")
   * @param {object} context - Event context { toolName, toolInput, taskId, ... }
   * @returns {object} Merged result: { decision, reason, modifiedInput }
   */
  async run(event, context) {
    if (!this.loaded) this.load();

    const eventHooks = this.hooks[event];
    if (!eventHooks || !Array.isArray(eventHooks) || eventHooks.length === 0) {
      return { decision: "allow" };
    }

    const results = [];

    for (const hook of eventHooks) {
      // Check matcher
      if (hook.matcher && hook.matcher !== "*") {
        if (context.toolName && context.toolName !== hook.matcher) {
          continue;
        }
      }

      try {
        const result = await this.executeHook(hook, event, context);
        results.push(result);

        // If any hook blocks, stop immediately
        if (result.decision === "block") {
          eventBus.emitEvent("hook:blocked", {
            event,
            hook: hook.matcher || "*",
            reason: result.reason,
            toolName: context.toolName,
          });
          return result;
        }
      } catch (error) {
        console.log(
          `[HookRunner] Hook error (${event}/${hook.matcher}): ${error.message}`
        );
        // Hook errors don't block execution - fail open
      }
    }

    // Merge results: first "ask" wins, otherwise "allow"
    const askResult = results.find((r) => r.decision === "ask");
    if (askResult) return askResult;

    // Check for modified input
    const modifiedResult = results.find((r) => r.modifiedInput);
    if (modifiedResult) {
      return { decision: "allow", modifiedInput: modifiedResult.modifiedInput };
    }

    return { decision: "allow" };
  }

  /**
   * Execute a single hook.
   */
  async executeHook(hook, event, context) {
    const timeout = hook.timeout || 5000;

    if (hook.type === "command") {
      return this.runCommandHook(hook.command, context, timeout);
    }

    if (hook.type === "js") {
      return this.runJsHook(hook.code, context);
    }

    return { decision: "allow" };
  }

  /**
   * Run a shell command hook.
   * Environment variables: TOOL_NAME, TOOL_INPUT, TASK_ID, EVENT
   */
  runCommandHook(command, context, timeout) {
    const env = {
      ...process.env,
      TOOL_NAME: context.toolName || "",
      TOOL_INPUT: JSON.stringify(context.toolInput || {}),
      TASK_ID: context.taskId || "",
      EVENT: context.event || "",
    };

    try {
      const output = execSync(command, {
        encoding: "utf-8",
        timeout,
        env,
      }).trim();

      // Try parsing JSON output
      try {
        return JSON.parse(output);
      } catch {
        // Non-JSON output = allow
        return { decision: "allow", output };
      }
    } catch (error) {
      // Command failed - treat as allow (fail open)
      return { decision: "allow", error: error.message };
    }
  }

  /**
   * Run an inline JavaScript hook.
   */
  runJsHook(code, context) {
    try {
      const fn = new Function("context", code);
      const result = fn(context);
      if (result && typeof result === "object" && result.decision) {
        return result;
      }
      return { decision: "allow" };
    } catch (error) {
      return { decision: "allow", error: error.message };
    }
  }

  /**
   * Convenience: run PreToolUse hooks.
   */
  async preToolUse(toolName, toolInput, taskId) {
    return this.run("PreToolUse", { toolName, toolInput, taskId });
  }

  /**
   * Convenience: run PostToolUse hooks.
   */
  async postToolUse(toolName, toolInput, toolOutput, taskId) {
    return this.run("PostToolUse", {
      toolName,
      toolInput,
      toolOutput,
      taskId,
    });
  }

  /**
   * Get hook stats.
   */
  stats() {
    if (!this.loaded) this.load();
    return Object.fromEntries(
      Object.entries(this.hooks).map(([k, v]) => [
        k,
        Array.isArray(v) ? v.length : 0,
      ])
    );
  }
}

const hookRunner = new HookRunner();
export default hookRunner;
