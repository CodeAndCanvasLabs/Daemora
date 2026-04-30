/**
 * Boot-time environment reader. The ONLY place process.env is read.
 *
 * This handles a small fixed set: PORT, DAEMORA_DATA_DIR, DAEMON_MODE,
 * LOG_LEVEL. Everything else (API keys, feature toggles, model picks)
 * lives in the vault or the settings store — never in env.
 *
 * Why this is strict: the bug pattern we keep hitting in current
 * Daemora is "stale env value persisted across config changes" (e.g.
 * DAEMORA_TTS_PROVIDER stuck on openai after the user picked Groq).
 * The fix is to NOT have those values in env in the first place.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ConfigError } from "../util/errors.js";
import { envOnly, type EnvKey } from "./schema.js";

export interface BootEnv {
  readonly port: number;
  readonly dataDir: string;
  readonly daemonMode: boolean;
  readonly logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
}

/** Parse process.env once at startup. Throws on any malformed value. */
export function readBootEnv(env: NodeJS.ProcessEnv = process.env): BootEnv {
  const port = parseField("PORT", env);
  const dataDirRaw = parseField("DAEMORA_DATA_DIR", env);
  const daemonMode = parseField("DAEMON_MODE", env);
  const logLevel = parseField("LOG_LEVEL", env);

  return {
    port: port as number,
    dataDir: (dataDirRaw as string | undefined) ?? defaultDataDir(),
    daemonMode: daemonMode as boolean,
    logLevel: logLevel as BootEnv["logLevel"],
  };
}

function parseField<K extends EnvKey>(key: K, env: NodeJS.ProcessEnv): unknown {
  const def = envOnly[key];
  const raw = env[String(key)];
  const result = def.schema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`Bad env var ${String(key)}: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Data dir resolution:
 *   1. DAEMORA_DATA_DIR env (explicit override)
 *   2. data/ in the project root (dev mode — like JS version)
 *   3. OS-standard app dir (bundled desktop app)
 */
function defaultDataDir(): string {
  // Dev mode: use data/ inside the project if it exists
  const projectData = join(process.cwd(), "data");
  if (existsSync(projectData)) return projectData;

  // Bundled: OS-standard app data dir
  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Application Support", "Daemora");
    case "win32":
      return join(process.env["APPDATA"] ?? join(home, "AppData", "Roaming"), "Daemora");
    default:
      return join(
        process.env["XDG_DATA_HOME"] ?? join(home, ".local", "share"),
        "daemora",
      );
  }
}
