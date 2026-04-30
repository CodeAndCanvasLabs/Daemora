/**
 * `daemora vault <action>` — secret management from terminal.
 *
 *   vault status                         show unlocked + key hints
 *   vault unlock [--passphrase <p>]      unlock with passphrase (reads stdin if omitted)
 *   vault lock                           relock
 *   vault list                           list known keys (no values)
 *   vault set <KEY> [--value <v>]        write a key (value from stdin or flag)
 *   vault get <KEY>                      print hint (last 4 chars) — never full value
 *   vault delete <KEY>                   remove a key
 *
 * Vault values are NEVER printed in full. `get` returns a 4-char hint.
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { ConfigManager } from "../../config/ConfigManager.js";
import { secrets as secretsSchema, type SecretKey } from "../../config/schema.js";

async function readPassphraseInteractive(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    // Piped: read full stdin
    return readFileSync(0, "utf-8").trim();
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(prompt);
  rl.close();
  return answer.trim();
}

function flag(args: readonly string[], name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

export async function vaultCommand(args: readonly string[]): Promise<void> {
  const action = args[0];
  if (!action || action === "help" || action === "--help") {
    printHelp();
    return;
  }

  const cfg = ConfigManager.open();
  try {
    switch (action) {
      case "status": {
        console.log(JSON.stringify({
          exists: cfg.vault.exists(),
          unlocked: cfg.vault.isUnlocked(),
          keys: cfg.vault.isUnlocked() ? cfg.vault.keys() : [],
        }, null, 2));
        return;
      }

      case "unlock": {
        const pass = flag(args, "passphrase")
          ?? process.env["VAULT_PASSPHRASE"]
          ?? await readPassphraseInteractive("Passphrase: ");
        if (!pass) { console.error("passphrase required"); process.exit(2); }
        cfg.vault.unlock(pass);
        console.log("unlocked");
        return;
      }

      case "lock": {
        cfg.vault.lock();
        console.log("locked");
        return;
      }

      case "list": {
        if (!cfg.vault.isUnlocked()) { console.error("vault is locked — run `vault unlock` first"); process.exit(3); }
        const keys = cfg.vault.keys();
        for (const k of keys) {
          const hint = cfg.vault.get(k)?.hint() ?? "(set)";
          console.log(`${k}  ${hint}`);
        }
        return;
      }

      case "set": {
        const key = args[1];
        if (!key) { console.error("missing KEY"); process.exit(2); }
        if (!(key in secretsSchema)) {
          console.error(`unknown secret key: ${key}`);
          console.error(`known: ${Object.keys(secretsSchema).join(", ")}`);
          process.exit(2);
        }
        if (!cfg.vault.isUnlocked()) { console.error("vault is locked — run `vault unlock` first"); process.exit(3); }
        const value = flag(args, "value") ?? await readPassphraseInteractive(`Value for ${key}: `);
        if (!value) { console.error("value required"); process.exit(2); }
        const def = secretsSchema[key as SecretKey];
        if (def.pattern && !def.pattern.test(value)) {
          console.error(`${key} doesn't match expected format ${def.pattern}`);
          process.exit(2);
        }
        cfg.vault.set(key, value);
        console.log(`set ${key}: ${cfg.vault.get(key)?.hint()}`);
        return;
      }

      case "get": {
        const key = args[1];
        if (!key) { console.error("missing KEY"); process.exit(2); }
        if (!cfg.vault.isUnlocked()) { console.error("vault is locked"); process.exit(3); }
        const s = cfg.vault.get(key);
        if (!s) { console.error(`no such key: ${key}`); process.exit(4); }
        console.log(s.hint());
        return;
      }

      case "delete":
      case "rm": {
        const key = args[1];
        if (!key) { console.error("missing KEY"); process.exit(2); }
        if (!cfg.vault.isUnlocked()) { console.error("vault is locked"); process.exit(3); }
        const removed = cfg.vault.delete(key);
        console.log(removed ? `removed ${key}` : `key not present: ${key}`);
        return;
      }

      default:
        console.error(`unknown vault action: ${action}`);
        printHelp();
        process.exit(2);
    }
  } finally {
    cfg.close();
  }
}

function printHelp(): void {
  console.log(`daemora vault <action>

Actions:
  status                            Show unlocked state + key hints
  unlock [--passphrase <p>]         Unlock the vault (reads stdin if no flag)
  lock                              Re-lock the vault
  list                              List known keys (no values)
  set <KEY> [--value <v>]           Store a secret (prompts if no flag)
  get <KEY>                         Print 4-char hint (never full value)
  delete <KEY>                      Remove a secret

Values are never printed in full — only a 4-char hint.`);
}
