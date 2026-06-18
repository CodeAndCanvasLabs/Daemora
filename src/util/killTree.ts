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
import { userInfo } from "node:os";

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

/**
 * Belt-and-suspenders to `findDescendants`: find processes that *look*
 * like daemora spawn but are no longer in our descendant tree because
 * their immediate parent died early and init adopted them (PPID=1).
 *
 * Real case: the LiveKit voice worker forks `@livekit/agents`
 * `job_proc_lazy_main.js` via Node IPC. If the voice worker crashes or
 * is killed before its job_proc child, the job_proc gets reparented to
 * init and falls out of `pgrep -P` from the daemora root. We end up
 * with a long-running orphan node process pegging memory and holding
 * file handles for days.
 *
 * The match is scoped tightly to avoid hitting *other* daemora installs
 * or the user's unrelated playwright sessions:
 *   - voice-worker.mjs / job_proc whose argv references THIS install's
 *     `<installRoot>/dist/voice-worker.mjs`
 *   - playwright-mcp / computer-use children whose argv names THIS
 *     install's `<dataDir>/` paths (browser profile, output dir, etc.)
 *
 * Pass both `installRoot` (the daemora repo / install dir, containing
 * `dist/`) and `dataDir` (where browser profiles + outputs live).
 */
export function findOrphanedDaemoraProcesses(installRoot: string, dataDir: string): number[] {
  let out: string;
  try {
    out = execFileSync("ps", ["-axo", "pid=,user=,command="], { encoding: "utf-8" });
  } catch {
    return [];
  }
  const currentUser = userInfo().username;
  const me = process.pid;
  const voiceWorkerPath = `${installRoot}/dist/voice-worker.mjs`;
  const matches: number[] = [];

  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isInteger(pid) || pid <= 1 || pid === me) continue;
    if (m[2] !== currentUser) continue;
    const cmd = m[3] ?? "";

    const isVoiceWorker = cmd.includes(voiceWorkerPath);
    const isLiveKitJobProc =
      cmd.includes("@livekit/agents") &&
      cmd.includes("job_proc") &&
      cmd.includes(voiceWorkerPath);
    const isOurMcpChild =
      cmd.includes(`--user-data-dir ${dataDir}`) ||
      cmd.includes(`--user-data-dir=${dataDir}`) ||
      cmd.includes(`--output-dir ${dataDir}`) ||
      cmd.includes(`--output-dir=${dataDir}`);

    if (isVoiceWorker || isLiveKitJobProc || isOurMcpChild) matches.push(pid);
  }
  return matches;
}

/**
 * Send `signal` to every orphan that `findOrphanedDaemoraProcesses`
 * turns up. Returns the count actually signalled.
 */
export function signalOrphaned(
  installRoot: string,
  dataDir: string,
  signal: NodeJS.Signals = "SIGTERM",
): number {
  const pids = findOrphanedDaemoraProcesses(installRoot, dataDir);
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
