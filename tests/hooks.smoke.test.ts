/**
 * Smoke tests for HookRunner:
 *  - with no hooks.json, every event returns allow
 *  - a valid hooks.json with an allowing command runs + allows
 *  - a blocking command short-circuits further hooks
 *  - non-zero exit fails open (decision: allow)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HookRunner } from "../src/hooks/HookRunner.js";

function tmpDir(): string {
  const dir = `/tmp/daemora-hooks-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("HookRunner", () => {
  it("returns allow when no hooks.json exists", async () => {
    const dir = tmpDir();
    const h = new HookRunner(dir);
    const r = await h.run("PreToolUse", { taskId: "t1", toolName: "read_file" });
    expect(r.decision).toBe("allow");
  });

  it("blocks when a hook emits decision=block", async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, "hooks.json"),
      JSON.stringify({
        PreToolUse: [
          { kind: "command", matcher: "*", command: `echo '{"decision":"block","reason":"nope"}'` },
          { kind: "command", matcher: "*", command: "echo allow" },
        ],
      }),
    );
    const h = new HookRunner(dir);
    const r = await h.run("PreToolUse", { taskId: "t1", toolName: "exec" });
    expect(r.decision).toBe("block");
    expect(r.reason).toBe("nope");
  });

  it("fails open on non-zero exit", async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, "hooks.json"),
      JSON.stringify({
        PreToolUse: [{ kind: "command", matcher: "*", command: "exit 1" }],
      }),
    );
    const h = new HookRunner(dir);
    const r = await h.run("PreToolUse", { taskId: "t1", toolName: "exec" });
    expect(r.decision).toBe("allow");
  });

  it("only runs hooks whose matcher matches", async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, "hooks.json"),
      JSON.stringify({
        PreToolUse: [{ kind: "command", matcher: "only_this_tool", command: `echo '{"decision":"block"}'` }],
      }),
    );
    const h = new HookRunner(dir);
    const r = await h.run("PreToolUse", { taskId: "t1", toolName: "some_other_tool" });
    expect(r.decision).toBe("allow");
  });
});
