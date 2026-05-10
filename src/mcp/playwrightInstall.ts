/**
 * Ensure the `@playwright/mcp` server's `chrome-for-testing` browser
 * binary is installed on disk.
 *
 * The MCP server defers its browser download to the first navigation —
 * so the MCP server "connects" successfully but fails the first real
 * tool call with `Browser "chrome-for-testing" is not installed. Run
 * npx @playwright/mcp install-browser chrome-for-testing to install`.
 * The model can't auto-recover from that.
 *
 * We just run that exact command. It's idempotent — fast when already
 * installed, correct when not. We don't try to be clever with cache
 * lookups: the MCP server's own install-browser subcommand owns the
 * truth about "what binary does this MCP build want?".
 *
 * Single-flight: concurrent callers (UI Enable click + agent's
 * `manage_mcp enable` tool firing at the same time) share one install
 * run.
 */

import { spawn } from "node:child_process";

import { createLogger } from "../util/logger.js";

const log = createLogger("mcp.playwright-install");

export type EnsureResult =
  | { status: "installed" }
  | { status: "failed"; error: string };

let inflight: Promise<EnsureResult> | null = null;

export function ensurePlaywrightChromium(): Promise<EnsureResult> {
  if (inflight) return inflight;
  inflight = run().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function run(): Promise<EnsureResult> {
  log.info("ensuring chrome-for-testing via 'npx -y @playwright/mcp@latest install-browser chrome-for-testing'");
  return await new Promise<EnsureResult>((resolve) => {
    const proc = spawn("npx", ["-y", "@playwright/mcp@latest", "install-browser", "chrome-for-testing"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stderr = "";
    proc.stdout?.on("data", (b: Buffer) => log.debug({ out: b.toString().trim() }, "mcp install-browser"));
    proc.stderr?.on("data", (b: Buffer) => {
      const line = b.toString();
      stderr += line;
      log.debug({ err: line.trim() }, "mcp install-browser");
    });
    proc.on("error", (err) => {
      log.error({ err: err.message }, "mcp install-browser spawn failed");
      resolve({ status: "failed", error: err.message });
    });
    proc.on("close", (code) => {
      if (code === 0) {
        log.info("chrome-for-testing ready");
        resolve({ status: "installed" });
      } else {
        log.error({ code, stderr: stderr.slice(-500) }, "mcp install-browser exited non-zero");
        resolve({ status: "failed", error: `@playwright/mcp install-browser exited ${code}` });
      }
    });
  });
}
