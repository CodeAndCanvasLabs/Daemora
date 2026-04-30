/**
 * Structured logger. Pino under the hood — fast JSON in production,
 * pretty-printed in dev. Use child loggers for module scoping.
 *
 * Two destinations always:
 *   1. Stdout — pretty in dev, JSON in prod (existing behaviour).
 *   2. File — JSONL appended to `${dataDir}/logs/daemora-YYYY-MM-DD.jsonl`,
 *      one record per line. Captures every tool call, sub-agent spawn,
 *      model turn etc. so the user can trace what daemora did while
 *      they were away. Daily rotation keeps individual files small.
 *
 * The dataDir is resolved the same way ConfigManager does: from
 * `DAEMORA_DATA_DIR` env, falling back to `~/.daemora`. This avoids a
 * circular import (config depends on logger). If the directory can't
 * be created we silently skip the file sink rather than crash boot.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, createWriteStream } from "node:fs";

import pino, { type Logger, type StreamEntry, multistream } from "pino";

const isDev = process.env["NODE_ENV"] !== "production";
const level = process.env["LOG_LEVEL"] ?? (isDev ? "debug" : "info");

function resolveLogFile(): string | null {
  try {
    const dataDir = process.env["DAEMORA_DATA_DIR"] ?? join(homedir(), ".daemora");
    const logsDir = join(dataDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return join(logsDir, `daemora-${date}.jsonl`);
  } catch {
    return null;
  }
}

function buildRoot(): Logger {
  const streams: StreamEntry[] = [];

  // Stdout — pretty in dev, JSON in prod.
  if (isDev) {
    const pretty = pino.transport({
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
    });
    streams.push({ level: level as pino.Level, stream: pretty });
  } else {
    streams.push({ level: level as pino.Level, stream: process.stdout });
  }

  // File sink — always JSON, captures everything at the configured level.
  const logFile = resolveLogFile();
  if (logFile) {
    const fileStream = createWriteStream(logFile, { flags: "a" });
    streams.push({ level: level as pino.Level, stream: fileStream });
  }

  return pino({ level }, multistream(streams));
}

const root: Logger = buildRoot();

/** Create a logger scoped to a module/component. */
export function createLogger(module: string): Logger {
  return root.child({ module });
}

export const logger = root;
