/**
 * Auto-build for the project Live Preview.
 *
 * When the Preview tab opens a coding project that has source but no built
 * output yet, we compile it on demand (npm install + npm run build) instead of
 * relying on the agent having kept a dev server alive. The build runs under the
 * SAME OS sandbox as the agent's shell (it executes the project's own npm
 * scripts, which are untrusted), writing static output the preview then serves.
 *
 * State is kept in-process per project: one build at a time, with a short log
 * tail for the "Building…"/"Failed" pages.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { FilesystemGuard } from "../../safety/FilesystemGuard.js";
import { macSandboxProfile, safeShellEnv, SANDBOX_EXEC } from "../../tools/core/executeCommand.js";
import { createLogger } from "../../util/logger.js";

const log = createLogger("preview.build");

export type BuildStatus = "ready" | "building" | "failed" | "not-buildable";

interface BuildState { status: "building" | "failed"; startedAt: number; log: string }

const builds = new Map<string, BuildState>();

/** Output dirs a build may produce (matches the preview's static candidates). */
const OUTPUT_DIRS = ["dist", "out", "build"] as const;

/** Where the buildable app lives: <project>/code if it has package.json, else <project>. */
function codeDirFor(projectRoot: string): string | null {
  const codeSub = join(projectRoot, "code");
  if (existsSync(join(codeSub, "package.json"))) return codeSub;
  if (existsSync(join(projectRoot, "package.json"))) return projectRoot;
  return null;
}

function hasBuiltOutput(codeDir: string): boolean {
  return OUTPUT_DIRS.some((d) => existsSync(join(codeDir, d, "index.html")));
}

/**
 * Ensure the project is (being) built. Non-blocking: kicks a build off in the
 * background if needed and returns the current status immediately.
 */
export function ensureBuild(slug: string, projectRoot: string, guard: FilesystemGuard): BuildStatus {
  const codeDir = codeDirFor(projectRoot);
  if (!codeDir) return "not-buildable";
  if (hasBuiltOutput(codeDir)) { builds.delete(slug); return "ready"; }

  const cur = builds.get(slug);
  if (cur?.status === "building") return "building";
  if (cur?.status === "failed") return "failed";

  startBuild(slug, codeDir, guard);
  return "building";
}

export function buildLog(slug: string): string {
  return builds.get(slug)?.log ?? "";
}

/** Reset a failed/stale build so the next preview open retries. */
export function clearBuild(slug: string): void { builds.delete(slug); }

function startBuild(slug: string, codeDir: string, guard: FilesystemGuard): void {
  const state: BuildState = { status: "building", startedAt: Date.now(), log: "" };
  builds.set(slug, state);
  log.info({ slug, codeDir }, "preview auto-build started");

  // install deps only if missing, then build. Cache writes land under HOME
  // (pointed at the tenant dir by the sandbox), not the project root.
  const command = "{ [ -d node_modules ] || npm install --no-audit --no-fund --silent; } && npm run build";

  const desc = guard.describe();
  const allowRoots = Array.from(new Set([...(desc.allow ?? []), ...(desc.dataDir ? [desc.dataDir] : [])]));
  const denyRoots = Array.from(new Set(["/Users", process.env["HOME"] ?? ""].filter(Boolean)));
  const sandbox = desc.mode === "sandbox" && process.platform === "darwin" && existsSync(SANDBOX_EXEC) && allowRoots.length > 0;
  const env = desc.mode === "sandbox"
    ? { ...safeShellEnv(), ...(desc.dataDir ? { HOME: desc.dataDir } : {}) }
    : process.env;

  const child = sandbox
    ? spawn(SANDBOX_EXEC, ["-p", macSandboxProfile(allowRoots, denyRoots), "/bin/bash", "-c", command], { cwd: codeDir, env, stdio: ["ignore", "pipe", "pipe"] })
    : spawn(command, { cwd: codeDir, env, shell: "/bin/bash", stdio: ["ignore", "pipe", "pipe"] });

  const cap = (s: string) => { state.log = (state.log + s).slice(-4000); };
  child.stdout?.on("data", (c: Buffer) => cap(c.toString()));
  child.stderr?.on("data", (c: Buffer) => cap(c.toString()));

  // hard cap so a hung build doesn't pin a slot forever
  const timer = setTimeout(() => { child.kill("SIGKILL"); }, 5 * 60_000);
  timer.unref();

  child.once("error", (err) => {
    clearTimeout(timer);
    state.status = "failed"; cap(`\n[spawn error] ${(err as Error).message}`);
    log.warn({ slug, err: (err as Error).message }, "preview build spawn failed");
  });
  child.once("close", (code) => {
    clearTimeout(timer);
    if (code === 0 && hasBuiltOutput(codeDir)) {
      builds.delete(slug); // ready — next request serves the output
      log.info({ slug }, "preview auto-build complete");
    } else {
      state.status = "failed";
      log.warn({ slug, code }, "preview build failed");
    }
  });
}
