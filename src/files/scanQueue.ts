/**
 * Async image-scan queue for the Files feature.
 *
 * On upload, the route fires `enqueue(slug, fileId)` and returns
 * immediately so the user isn't blocked on a 30-second Vertex call.
 * The worker writes the filer markdown sidecar and flips the file's
 * `scanStatus` from "pending" → "scanning" → "completed" (or "failed"
 * on error, with `scanError` populated).
 *
 * Crash recovery: on startup, `recoverPending()` scans every project
 * for files left in pending/scanning state and re-enqueues them. Safe
 * because writes go through the temp-file rename pattern in
 * FileProjectStore, so a partial filer is never observed.
 *
 * Concurrency: capped at 2 in-flight scans to avoid hammering Vertex
 * quota. The queue is in-process; restarts re-pick-up from disk.
 */

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

import type { ConfigManager } from "../config/ConfigManager.js";
import { createLogger } from "../util/logger.js";
import type { FileProjectStore } from "./FileProjectStore.js";
import { buildImageFiler } from "./imageFiler.js";

const log = createLogger("files.scan");
const MAX_CONCURRENCY = 2;

export class ScanQueue {
  private readonly pending: { slug: string; fileId: string }[] = [];
  private inFlight = 0;
  private stopped = false;

  constructor(
    private readonly store: FileProjectStore,
    private readonly cfg: ConfigManager,
  ) {}

  /** Add a file to the queue. No-op if already pending in memory. */
  enqueue(slug: string, fileId: string): void {
    if (this.stopped) return;
    if (this.pending.some((j) => j.slug === slug && j.fileId === fileId)) return;
    this.pending.push({ slug, fileId });
    this.pump();
  }

  /**
   * On startup, find every file left in pending/scanning state and
   * re-enqueue. Handles "the process crashed mid-scan" cleanly.
   */
  recoverPending(): void {
    const stuck = this.store.pendingScans();
    if (stuck.length === 0) return;
    log.info({ count: stuck.length }, "recovering pending image scans");
    for (const job of stuck) this.enqueue(job.slug, job.fileId);
  }

  /** Stop accepting new jobs (for graceful shutdown). */
  stop(): void {
    this.stopped = true;
    this.pending.length = 0;
  }

  private pump(): void {
    while (!this.stopped && this.inFlight < MAX_CONCURRENCY && this.pending.length > 0) {
      const job = this.pending.shift()!;
      this.inFlight++;
      void this.runJob(job).finally(() => {
        this.inFlight--;
        this.pump();
      });
    }
  }

  private async runJob(job: { slug: string; fileId: string }): Promise<void> {
    const project = this.store.read(job.slug);
    if (!project) return;
    const file = project.files.find((f) => f.id === job.fileId);
    if (!file) return;
    if (file.kind !== "image") return; // non-images don't get a filer

    this.store.updateFile(job.slug, job.fileId, { scanStatus: "scanning" });

    try {
      const absImage = this.store.resolveAbs(job.slug, file.path);
      const markdown = await buildImageFiler(absImage, this.cfg);
      const filerRel = `filers/${file.filename}.md`;
      const filerAbs = this.store.resolveAbs(job.slug, filerRel);
      mkdirSync(dirname(filerAbs), { recursive: true });
      await writeFile(filerAbs, markdown, "utf-8");

      this.store.updateFile(job.slug, job.fileId, {
        scanStatus: "completed",
        filerPath: filerRel,
      });
      log.info({ slug: job.slug, file: file.filename }, "image filer written");
    } catch (e) {
      const message = (e as Error).message;
      this.store.updateFile(job.slug, job.fileId, {
        scanStatus: "failed",
        scanError: message,
      });
      log.warn({ slug: job.slug, file: file.filename, err: message }, "image scan failed");
    }
  }

  /** Snapshot of queue depth — used by tests / health endpoints. */
  depth(): { pending: number; inFlight: number } {
    return { pending: this.pending.length, inFlight: this.inFlight };
  }
}

// Compose two paths safely without relying on the caller passing
// trailing slashes. Used by callers that don't want to import path.
export function joinSafe(a: string, b: string): string {
  return join(a, b);
}
