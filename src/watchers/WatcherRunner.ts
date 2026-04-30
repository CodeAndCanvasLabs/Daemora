/**
 * WatcherRunner — supervises file + poll watchers defined in WatcherStore.
 *
 * Webhook watchers are driven by incoming HTTP (see WebhookHandler).
 * File and poll watchers run in-process; this class owns their lifecycle.
 *
 * On start(): spawn a FileWatcher or PollWatcher per enabled row.
 * On reload(): diff the current set against the store and add/remove
 *              watchers whose enabled/triggerType/config changed.
 * On stop():  tear everything down cleanly.
 *
 * When a watcher fires, we respect its `__cooldownSeconds` (same as the
 * webhook path) and enqueue a task via the TaskRunner with the watcher's
 * action prompt and a payload describing what changed.
 */

import type { TaskRunner } from "../core/TaskRunner.js";
import type { IntegrationManager } from "../integrations/IntegrationManager.js";
import type { IntegrationId } from "../integrations/types.js";
import { createLogger } from "../util/logger.js";
import type { WatcherRow, WatcherStore } from "./WatcherStore.js";
import { FileWatcher, type FileEventKind } from "./FileWatcher.js";
import { IntegrationWatcher, type IntegrationEvent } from "./IntegrationWatcher.js";
import { PollWatcher } from "./PollWatcher.js";

const log = createLogger("watcher-runner");

type AnyWatcher =
  | { kind: "file"; instance: FileWatcher; signature: string }
  | { kind: "poll"; instance: PollWatcher; signature: string }
  | { kind: "integration"; instance: IntegrationWatcher; signature: string };

interface WatcherRunnerDeps {
  readonly store: WatcherStore;
  /** Required for integration watchers; optional so the runner still
   *  boots when no integrations are configured. */
  readonly integrations?: IntegrationManager;
  readonly runner: TaskRunner;
}

export class WatcherRunner {
  private readonly active = new Map<string, AnyWatcher>();
  private started = false;

  constructor(private readonly deps: WatcherRunnerDeps) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.reload();
    log.info({ count: this.active.size }, "watcher runner started");
  }

  stop(): void {
    for (const w of this.active.values()) w.instance.stop();
    this.active.clear();
    this.started = false;
    log.info("watcher runner stopped");
  }

  /**
   * Sync active watchers with the store. Adds newly-enabled rows,
   * removes newly-disabled ones, restarts any whose config signature
   * changed (url, path, interval, etc.).
   */
  reload(): void {
    const rows = this.deps.store.list().filter(
      (w) => w.enabled && (
        w.triggerType === "file"
        || w.triggerType === "poll"
        || w.triggerType === "integration"
      ),
    );
    const wantedIds = new Set(rows.map((r) => r.id));

    // Tear down watchers that are no longer enabled / no longer present.
    for (const [id, w] of this.active.entries()) {
      if (!wantedIds.has(id)) {
        w.instance.stop();
        this.active.delete(id);
        log.info({ id }, "watcher stopped (removed/disabled)");
      }
    }

    // Start or restart each active row.
    for (const row of rows) {
      try {
        const signature = this.signatureFor(row);
        const existing = this.active.get(row.id);
        if (existing && existing.signature === signature) continue;
        if (existing) existing.instance.stop();
        const started = this.spawn(row);
        if (started) this.active.set(row.id, started);
      } catch (e) {
        log.error({ id: row.id, err: (e as Error).message }, "watcher start failed");
      }
    }
  }

  get activeCount(): number {
    return this.active.size;
  }

  // ── internal ──────────────────────────────────────────────────────

  private spawn(row: WatcherRow): AnyWatcher | null {
    const cfg = parseConfig(row.pattern);

    if (row.triggerType === "file") {
      const path = stringFrom(cfg["__path"]);
      if (!path) throw new Error(`watcher ${row.name}: __path required`);
      const instance = new FileWatcher(
        {
          path,
          ...(typeof cfg["__recursive"] === "boolean" ? { recursive: cfg["__recursive"] as boolean } : {}),
          ...(typeof cfg["__debounceMs"] === "number" ? { debounceMs: cfg["__debounceMs"] as number } : {}),
          ...(Array.isArray(cfg["__events"])
            ? { events: (cfg["__events"] as string[]).filter(isFileKind) }
            : {}),
        },
        (ev) => this.fire(row, { type: "file", ...ev }),
      );
      instance.start();
      log.info({ id: row.id, name: row.name, path }, "file watcher armed");
      return { kind: "file", instance, signature: this.signatureFor(row) };
    }

    if (row.triggerType === "poll") {
      const url = stringFrom(cfg["__url"]);
      if (!url) throw new Error(`watcher ${row.name}: __url required`);
      const instance = new PollWatcher(
        {
          url,
          ...(typeof cfg["__intervalMs"] === "number" ? { intervalMs: cfg["__intervalMs"] as number } : {}),
          ...(typeof cfg["__method"] === "string" ? { method: cfg["__method"] as string } : {}),
          ...(isStringRecord(cfg["__headers"]) ? { headers: cfg["__headers"] } : {}),
          ...(typeof cfg["__diffField"] === "string" ? { diffField: cfg["__diffField"] as string } : {}),
        },
        (ev) => this.fire(row, {
          type: "poll",
          url: ev.url,
          status: ev.status,
          previewBody: ev.body.slice(0, 2_000),
        }),
      );
      instance.start();
      log.info({ id: row.id, name: row.name, url }, "poll watcher armed");
      return { kind: "poll", instance, signature: this.signatureFor(row) };
    }

    if (row.triggerType === "integration") {
      if (!this.deps.integrations) {
        log.warn({ id: row.id, name: row.name }, "integration watcher requested but IntegrationManager not wired");
        return null;
      }
      const integration = stringFrom(cfg["__integration"]) as IntegrationId | "";
      const event = stringFrom(cfg["__event"]) as IntegrationEvent | "";
      if (!integration || !event) {
        throw new Error(`watcher ${row.name}: __integration and __event required`);
      }
      const params: Record<string, string> = {};
      if (isStringRecord(cfg["__params"])) {
        for (const [k, v] of Object.entries(cfg["__params"])) {
          if (typeof v === "string") params[k] = v;
        }
      }
      const instance = new IntegrationWatcher(
        this.deps.integrations,
        {
          integration,
          event,
          ...(typeof cfg["__intervalMs"] === "number" ? { intervalMs: cfg["__intervalMs"] as number } : {}),
          params,
        },
        (ev) => this.fire(row, {
          type: "integration",
          integration: ev.integration,
          event: ev.event,
          item: ev.item,
        }),
      );
      instance.start();
      log.info(
        { id: row.id, name: row.name, integration, event },
        "integration watcher armed",
      );
      return { kind: "integration", instance, signature: this.signatureFor(row) };
    }

    return null;
  }

  private fire(row: WatcherRow, payload: Record<string, unknown>): void {
    const cfg = parseConfig(row.pattern);
    const cooldown = typeof cfg["__cooldownSeconds"] === "number" ? (cfg["__cooldownSeconds"] as number) : 0;
    if (cooldown > 0 && row.lastTriggeredAt !== null) {
      const elapsed = (Date.now() - row.lastTriggeredAt) / 1000;
      if (elapsed < cooldown) {
        log.debug({ id: row.id, remaining: Math.ceil(cooldown - elapsed) }, "watcher cooldown — skipping");
        return;
      }
    }
    const input = `[Watcher: ${row.name}] ${row.action}\n\nPayload:\n${JSON.stringify(payload, null, 2)}`;
    const handle = this.deps.runner.run({
      input,
      sessionId: "main",
      ...(row.channel ? { channel: row.channel } : {}),
    });
    this.deps.store.markTriggered(row.id);
    log.info({ id: row.id, name: row.name, taskId: handle.taskId }, "watcher fired");
  }

  /**
   * Any change to enabled/triggerType/pattern should trigger a restart.
   * We deliberately do NOT include lastTriggeredAt/triggerCount.
   */
  private signatureFor(row: WatcherRow): string {
    return `${row.triggerType}|${row.enabled ? 1 : 0}|${row.pattern}|${row.channel ?? ""}|${row.action}`;
  }
}

function parseConfig(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringFrom(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== "object") return false;
  return Object.values(v as object).every((x) => typeof x === "string");
}

function isFileKind(v: string): v is FileEventKind {
  return v === "add" || v === "change" || v === "unlink";
}
