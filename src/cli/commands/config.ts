/**
 * `daemora config <action>` — setting get/set/list from terminal.
 *
 *   config list                     list all settings + source
 *   config get <KEY>                print current value
 *   config set <KEY> <VALUE>        write a setting (schema-validated)
 *   config unset <KEY>              remove a setting override
 */

import { ConfigManager } from "../../config/ConfigManager.js";
import {
  isSetting as schemaIsSetting,
  type SettingKey,
} from "../../config/schema.js";

export async function configCommand(args: readonly string[]): Promise<void> {
  const action = args[0];
  if (!action || action === "help" || action === "--help") {
    printHelp();
    return;
  }

  const cfg = ConfigManager.open();
  try {
    switch (action) {
      case "list": {
        const fields = cfg.inspect().filter((f) => f.kind === "setting");
        for (const f of fields) {
          const val = "value" in f ? JSON.stringify(f.value) : "";
          console.log(`${f.key.padEnd(32)}  [${f.source}]  ${val}`);
        }
        return;
      }

      case "get": {
        const key = args[1];
        if (!key) { console.error("missing KEY"); process.exit(2); }
        if (!schemaIsSetting(key)) {
          // Fall back to generic read
          const v = cfg.settings.getGeneric(key);
          if (v === undefined) { console.error(`no such setting: ${key}`); process.exit(4); }
          console.log(typeof v === "string" ? v : JSON.stringify(v));
          return;
        }
        const v = cfg.setting(key as SettingKey);
        console.log(v === null || v === undefined ? "(unset)" : JSON.stringify(v));
        return;
      }

      case "set": {
        const key = args[1];
        const value = args[2];
        if (!key || value === undefined) {
          console.error("usage: config set <KEY> <VALUE>");
          process.exit(2);
        }
        // Try JSON parse first (so `config set FOO 42` stores a number),
        // fall back to plain string.
        let parsed: unknown;
        try { parsed = JSON.parse(value); } catch { parsed = value; }
        if (schemaIsSetting(key)) {
          cfg.settings.set(key as SettingKey, parsed as never);
        } else {
          cfg.settings.setGeneric(key, parsed);
        }
        console.log(`set ${key} = ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
        return;
      }

      case "unset": {
        const key = args[1];
        if (!key) { console.error("missing KEY"); process.exit(2); }
        if (schemaIsSetting(key)) {
          cfg.settings.reset(key as SettingKey);
        } else {
          console.warn(`note: generic key removal not implemented for ${key}`);
        }
        console.log(`unset ${key}`);
        return;
      }

      default:
        console.error(`unknown config action: ${action}`);
        printHelp();
        process.exit(2);
    }
  } finally {
    cfg.close();
  }
}

function printHelp(): void {
  console.log(`daemora config <action>

Actions:
  list                  List all settings with source (default, settings, env)
  get <KEY>             Print current value
  set <KEY> <VALUE>     Write a setting (JSON parsed if possible)
  unset <KEY>           Remove a settings override`);
}
