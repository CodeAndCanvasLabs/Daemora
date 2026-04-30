#!/usr/bin/env node
/**
 * Daemora CLI entry. Routes subcommands; each command lives in
 * its own file under cli/commands/.
 *
 * Usage: tsx src/cli/index.ts <command>
 *   start      run the HTTP server
 *   setup      first-run wizard (interactive in TTY, prints URL otherwise)
 *   doctor     diagnose config + connectivity
 *   version    print package version
 */

// MUST be the very first import. Side-effect-only — populates
// process.env from .env before any downstream module reads top-level
// env constants (e.g. ModelRouter's DAEMORA_VERTEX_SA_KEY_PATH). ESM
// guarantees this module is fully evaluated before the next import is
// processed.
import "./loadEnv.js";

import { readFileSync } from "node:fs";

import { configCommand } from "./commands/config.js";
import { daemonCommand } from "./commands/daemon.js";
import { doctorCommand } from "./commands/doctor.js";
import { setupCommand } from "./commands/setup.js";
import { startCommand } from "./commands/start.js";
import { vaultCommand } from "./commands/vault.js";

async function main(): Promise<void> {
  const [, , cmd] = process.argv;
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "version":
    case "--version":
    case "-v": {
      const pkg = JSON.parse(
        readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
      ) as { version: string };
      console.log(`daemora v${pkg.version}`);
      return;
    }
    case "start":
      await startCommand();
      return;
    case "setup":
      await setupCommand();
      return;
    case "daemon":
      await daemonCommand(process.argv.slice(3));
      return;
    case "doctor":
      await doctorCommand();
      return;
    case "vault":
      await vaultCommand(process.argv.slice(3));
      return;
    case "config":
      await configCommand(process.argv.slice(3));
      return;
    case "voice-worker":
    case "voice": {
      // LiveKit voice agent worker — runs as separate process
      // Uses dynamic import so LiveKit deps are only loaded when needed
      await import("../voice/VoiceAgent.js");
      return;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(2);
  }
}

function printHelp(): void {
  console.log(`Daemora

Commands:
  start          Run the HTTP server (auto-opens setup URL if not configured)
  setup          First-run interactive setup (vault + provider + model)
  daemon <cmd>   Manage the OS background service
                   install | uninstall | start | stop | restart | status
                   Optional: --passphrase <value>
  doctor         Self-diagnose (providers, vault, db, skills, mcp, memory)
  vault <cmd>    Secret management (status | unlock | lock | list | set | get | delete)
  config <cmd>   Settings management (list | get | set | unset)
  voice-worker   Run the LiveKit voice agent worker (STT → Daemora → TTS)
  version        Print version
  help           Show this help
`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
