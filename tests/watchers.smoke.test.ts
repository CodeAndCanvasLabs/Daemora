/**
 * Smoke tests for file + poll watchers and the WatcherRunner supervisor.
 *
 *  - FileWatcher: debounces rapid-fire writes, classifies add/change/unlink
 *  - PollWatcher: first poll seeds state (no fire); second differing poll fires
 *  - WatcherRunner: starts file/poll watchers per enabled row; reload syncs
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigManager } from "../src/config/ConfigManager.js";
import type { TaskRunner } from "../src/core/TaskRunner.js";
import { FileWatcher } from "../src/watchers/FileWatcher.js";
import { PollWatcher } from "../src/watchers/PollWatcher.js";
import { WatcherRunner } from "../src/watchers/WatcherRunner.js";
import { WatcherStore } from "../src/watchers/WatcherStore.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function tmpDir(): string {
  const dir = `/tmp/daemora-watchers-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

function startHttpServer(handler: (method: string) => { status: number; body: string }): Promise<{ url: string; close: () => void; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const { status, body } = handler(req.method ?? "GET");
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close(), server });
    });
  });
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

describe("FileWatcher", () => {
  it("debounces rapid writes into a single fire", async () => {
    const dir = tmpDir();
    const target = join(dir, "note.txt");
    writeFileSync(target, "initial");
    const fired: { paths: string[]; kinds: string[] }[] = [];
    const w = new FileWatcher({ path: target, debounceMs: 100 }, (ev) =>
      fired.push({ paths: [...ev.paths], kinds: [...ev.kinds] }),
    );
    w.start();
    cleanup.push(() => w.stop());

    for (let i = 0; i < 5; i++) {
      writeFileSync(target, `body ${i}`);
      await sleep(10);
    }
    await sleep(200);
    expect(fired.length).toBe(1);
    expect(fired[0]!.kinds).toContain("change");
  });

  it("filters events by config", async () => {
    const dir = tmpDir();
    const target = join(dir, "x.txt");
    writeFileSync(target, "seed");
    const fired: unknown[] = [];
    const w = new FileWatcher({ path: target, debounceMs: 50, events: ["unlink"] }, (ev) => fired.push(ev));
    w.start();
    cleanup.push(() => w.stop());
    writeFileSync(target, "still here");
    await sleep(120);
    expect(fired.length).toBe(0);
  });
});

describe("PollWatcher", () => {
  it("seeds on first poll (no fire) then fires on body change", async () => {
    let version = 1;
    const http = await startHttpServer(() => ({ status: 200, body: JSON.stringify({ v: version }) }));
    cleanup.push(http.close);

    const fired: unknown[] = [];
    const w = new PollWatcher({ url: http.url, intervalMs: 60_000 }, (ev) => fired.push(ev));
    // Drive polls manually — start() schedules the interval, but we
    // don't want to wait for it in tests.
    await w.poll();
    expect(fired.length).toBe(0);

    version = 2;
    await w.poll();
    expect(fired.length).toBe(1);

    await w.poll(); // no change → no fire
    expect(fired.length).toBe(1);
  });

  it("ignores non-2xx responses without firing or crashing", async () => {
    const http = await startHttpServer(() => ({ status: 500, body: "boom" }));
    cleanup.push(http.close);
    const fired: unknown[] = [];
    const w = new PollWatcher({ url: http.url }, (ev) => fired.push(ev));
    await w.poll();
    await w.poll();
    expect(fired.length).toBe(0);
  });
});

describe("WatcherRunner", () => {
  it("starts file/poll watchers for enabled rows and tears them down on reload", async () => {
    const dir = tmpDir();
    const cfg = ConfigManager.open({ dataDir: join(dir, "db") });
    const store = new WatcherStore(cfg.database);

    const target = join(dir, "seed.txt");
    writeFileSync(target, "a");

    const runCalls: string[] = [];
    const runner = {
      run: (opts: { input: string; sessionId?: string }) => {
        runCalls.push(opts.input);
        return { taskId: "t1", sessionId: opts.sessionId ?? "s", done: Promise.resolve({ status: "completed" as const, result: "" }) };
      },
    } as unknown as TaskRunner;

    const w = store.create({
      name: "file-w",
      triggerType: "file",
      action: "note changed",
      pattern: JSON.stringify({ __path: target, __debounceMs: 50 }),
    });
    const sup = new WatcherRunner({ store, runner });
    sup.start();
    cleanup.push(() => sup.stop());

    expect(sup.activeCount).toBe(1);

    // Give fs.watch a tick to arm on macOS before the first write.
    await sleep(50);
    writeFileSync(target, "b");
    await sleep(300);
    expect(runCalls.length).toBeGreaterThanOrEqual(1);
    expect(runCalls[0]).toContain("file-w");

    // Disable the watcher and reload — active count drops to 0.
    store.update(w.id, { enabled: false });
    sup.reload();
    expect(sup.activeCount).toBe(0);

    // Restore a simple mock env method for cleanup safety
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });
});
