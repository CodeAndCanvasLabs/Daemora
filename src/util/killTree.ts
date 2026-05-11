/**
 * Process-tree kill helper.
 *
 * Daemora spawns a lot of child processes:
 *   - The LiveKit voice worker (which itself spawns @livekit/agents
 *     job_proc workers).
 *   - Stdio MCP servers (one subprocess per enabled MCP).
 *   - `execute_command` bash shells, which can themselves spawn
 *     `npx remotion render` → node → chrome-headless-shell trees that
 *     are 5+ levels deep.
 *
 * Without help, when daemora gets SIGINT/SIGTERM only the voice route's
 * own kill calls fire — every other spawned process becomes an orphan
 * reparented to launchd/init and keeps running. That's the "100s of
 * stale node + chrome-headless leftovers" bug.
 *
 * This helper walks the descendant tree of a given PID via `pgrep -P`
 * and signals each one. Use it from the daemon's shutdown handler so
 * `kill daemora` actually kills daemora and everything it ever
 * spawned.
 */

import { execFileSync } from "node:child_process";

/**
 * Find every descendant PID of `rootPid` (children, grandchildren, …),
 * deepest-first so callers can SIGTERM leaves before parents and avoid
 * a parent re-spawning its child between signals.
 *
 * Synchronous on purpose — runs from `shutdown()` where we don't have
 * the luxury of awaiting promises before `process.exit()`.
 */
export function findDescendants(rootPid: number): number[] {
  const order: number[] = [];

  const visit = (pid: number): void => {
    let kids: number[] = [];
    try {
      const out = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf-8" }).trim();
      kids = out.length > 0 ? out.split("\n").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0) : [];
    } catch {
      // pgrep exits non-zero when there are no children — that's fine.
    }
    for (const k of kids) {
      visit(k);
      order.push(k);
    }
  };

  visit(rootPid);
  return order; // leaves first, then parents
}

/** Send `signal` to every descendant of `rootPid`. Errors per-pid are swallowed (process may have already exited). */
export function signalTree(rootPid: number, signal: NodeJS.Signals = "SIGTERM"): number {
  const pids = findDescendants(rootPid);
  let signalled = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      signalled++;
    } catch {
      // Already gone, or no permission — skip.
    }
  }
  return signalled;
}
