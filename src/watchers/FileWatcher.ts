/**
 * FileWatcher — one `fs.watch`-backed watcher per watcher row.
 *
 * Config (stored in the watcher's `pattern` JSON blob):
 *   __path         absolute path to a file or directory (required)
 *   __recursive    watch subdirectories (default: true for dirs)
 *   __debounceMs   coalesce rapid-fire events into one fire (default 2000)
 *   __events       which fs events fire the action — subset of
 *                  ["add", "change", "unlink"] (default: all three)
 *
 * `fs.watch` emits "rename" and "change". We translate:
 *   rename + path exists  → "add"       (or "change" if was present — dedup by stat)
 *   rename + path missing → "unlink"
 *   change                → "change"
 *
 * Debouncing avoids 50× editor saves in one second each becoming an
 * agent run. The last event inside the debounce window is the one that
 * fires, carrying the cumulative list of changed paths.
 */

import { existsSync, statSync, type FSWatcher, watch } from "node:fs";
import { resolve } from "node:path";

import { createLogger } from "../util/logger.js";

const log = createLogger("file-watcher");

const DEFAULT_DEBOUNCE_MS = 2_000;

export type FileEventKind = "add" | "change" | "unlink";

export interface FileWatcherConfig {
  readonly path: string;
  readonly recursive?: boolean;
  readonly debounceMs?: number;
  readonly events?: readonly FileEventKind[];
}

export interface FileWatcherFireEvent {
  readonly paths: readonly string[];
  readonly kinds: readonly FileEventKind[];
}

export type FileWatcherCallback = (ev: FileWatcherFireEvent) => void;

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: Map<string, FileEventKind> = new Map();
  private readonly allowedEvents: ReadonlySet<FileEventKind>;
  private readonly debounceMs: number;
  private readonly absPath: string;
  private readonly isDir: boolean;

  constructor(
    private readonly config: FileWatcherConfig,
    private readonly onFire: FileWatcherCallback,
  ) {
    this.absPath = resolve(config.path);
    this.allowedEvents = new Set(config.events ?? ["add", "change", "unlink"]);
    this.debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.isDir = existsSync(this.absPath) ? statSync(this.absPath).isDirectory() : false;
  }

  start(): void {
    if (this.watcher) return;
    if (!existsSync(this.absPath)) {
      throw new Error(`FileWatcher: path does not exist: ${this.absPath}`);
    }
    // Directories get recursive watch by default; files always single.
    const recursive = this.isDir ? (this.config.recursive ?? true) : false;
    this.watcher = watch(this.absPath, { recursive, persistent: false }, (eventType, filename) => {
      // filename is null on some platforms for the root path itself —
      // fall back to the watched path so we still report something useful.
      const changed = filename ? resolve(this.absPath, filename) : this.absPath;
      const kind = classify(eventType, changed);
      if (!this.allowedEvents.has(kind)) return;
      this.pending.set(changed, kind);
      this.schedule();
    });
    this.watcher.on("error", (err) => {
      log.error({ path: this.absPath, err: err.message }, "fs.watch error");
    });
    log.info({ path: this.absPath, recursive, debounceMs: this.debounceMs }, "file watcher started");
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.pending.clear();
  }

  private schedule(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.pending.size === 0) return;
      const paths = [...this.pending.keys()];
      const kinds = [...new Set(this.pending.values())];
      this.pending.clear();
      try {
        this.onFire({ paths, kinds });
      } catch (e) {
        log.error({ err: (e as Error).message }, "file watcher callback threw");
      }
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }
}

function classify(eventType: string, path: string): FileEventKind {
  if (eventType === "rename") {
    return existsSync(path) ? "add" : "unlink";
  }
  return "change";
}
