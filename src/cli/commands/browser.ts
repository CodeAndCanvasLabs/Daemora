/**
 * `daemora browser` — opens a real Chromium window using a persistent
 * profile dir at `<dataDir>/browser/<profile>/`. The user signs into
 * accounts, accepts cookie banners, sets preferences, etc. On window
 * close the profile flushes to disk and the agent's browser tool reuses
 * the exact same path on its next persistent-mode action.
 *
 * Chromium-only by design — Firefox/WebKit are never imported and
 * never installed (we explicitly call `playwright install chromium`,
 * not bare `playwright install`).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { ConfigManager } from "../../config/ConfigManager.js";
import { logger } from "../../util/logger.js";
import { printBanner } from "../banner.js";

interface ParsedArgs {
  profile: string;
  help: boolean;
  list: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let profile = "default";
  let help = false;
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile" || a === "-p") {
      const next = argv[++i];
      if (next) profile = next;
    } else if (a === "--list" || a === "-l") {
      list = true;
    } else if (a === "--help" || a === "-h") {
      help = true;
    }
  }
  return { profile, help, list };
}

function printHelp(): void {
  console.log(`Usage: daemora browser [--profile <name>] [--list]

Opens Chromium with a persistent profile. Log into your accounts,
accept cookie banners, install extensions — anything you do is saved.
On close, the agent's browser inherits the same session as long as
the profile matches the one selected in Settings (or via the
DAEMORA_BROWSER_PROFILE setting).

Options:
  --profile, -p <name>   Profile name to open (default: "default")
  --list,    -l          List existing profiles + which is active for the agent
  --help,    -h          Show this help

Examples:
  daemora browser
  daemora browser --profile work
  daemora browser --list
`);
}

export async function browserCommand(argv: string[]): Promise<void> {
  // Suppress pino so the user sees clean output, not framework chatter.
  logger.level = "silent";

  const { profile, help, list } = parseArgs(argv);
  if (help) {
    printHelp();
    return;
  }

  const cfg = ConfigManager.open();

  if (list) {
    const { listProfiles, getActiveProfile } = await import("../../mcp/playwrightProfile.js");
    const names = listProfiles(cfg.env.dataDir);
    const active = getActiveProfile(cfg);
    if (names.length === 0) {
      console.log("No profiles yet. Run `daemora browser` to create the default one.");
      return;
    }
    console.log("Browser profiles:");
    for (const name of names) {
      const marker = name === active ? "  → " : "    ";
      const tag = name === active ? "  (active for agent)" : "";
      console.log(`${marker}${name}${tag}`);
    }
    if (!names.includes(active)) {
      console.log(`\nNote: active profile "${active}" has no on-disk dir yet.`);
    }
    console.log("\nSwitch the agent's active profile from the Settings UI or via the API.");
    return;
  }

  const userDataDir = join(cfg.env.dataDir, "browser", profile);
  mkdirSync(userDataDir, { recursive: true });

  printBanner({ tagline: "browser session" });
  console.log(`Profile: ${profile}`);
  console.log(`Path:    ${userDataDir}`);
  console.log("");

  // Lazy-import so daemora itself doesn't crash if playwright isn't installed.
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("Playwright not installed. Run:");
    console.error("  npm i playwright && npx playwright install chromium");
    process.exit(1);
  }

  // Auto-install the Chromium binary on first run. `executablePath()` throws
  // when the browser hasn't been downloaded yet — we catch that and run the
  // installer ourselves so the user never sees an opaque error.
  try {
    chromium.executablePath();
  } catch {
    console.log("Chromium binary not found — installing (one-time, ~150 MB)…");
    const r = spawnSync("npx", ["-y", "playwright", "install", "chromium"], { stdio: "inherit" });
    if (r.status !== 0) {
      console.error("Chromium install failed. Run manually: npx playwright install chromium");
      process.exit(1);
    }
  }

  console.log("Launching Chromium… log in to your accounts, then close the window when done.");
  console.log("");

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: null,
    acceptDownloads: true,
    bypassCSP: true,
    ignoreHTTPSErrors: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-infobars",
    ],
  });

  if (ctx.pages().length === 0) await ctx.newPage();

  let closing = false;
  const close = async (reason: "user" | "signal"): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      await ctx.close();
    } catch {
      // already closed
    }
    console.log(reason === "signal" ? "\nInterrupted — profile saved." : "\nProfile saved.");
    console.log("The agent will reuse this session on its next browser action.");
    process.exit(0);
  };

  // Trap Ctrl+C so cookies flush before exit (Chromium buffers writes).
  process.on("SIGINT", () => void close("signal"));
  process.on("SIGTERM", () => void close("signal"));
  ctx.on("close", () => void close("user"));

  // Hold the process — close handlers terminate it.
  await new Promise<void>(() => undefined);
}
