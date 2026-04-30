/**
 * Smoke test for the webhook auth + HMAC stack.
 *  - templates catalogue is non-empty + well-formed
 *  - per-watcher bearer verifies correctly, timing-safe
 *  - GitHub HMAC verifies a real SHA256 signature
 *  - Stripe HMAC verifies with timestamp tolerance
 *  - HMAC replay outside tolerance fails
 *  - generic endpoint routes the bearer path end-to-end
 */

import { AddressInfo } from "node:net";
import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import Database from "better-sqlite3";
import express from "express";

import type { AuthStore } from "../src/auth/AuthStore.js";
import type { TaskRunner } from "../src/core/TaskRunner.js";
import { mountWebhookRoutes } from "../src/webhooks/WebhookHandler.js";
import { WatcherStore } from "../src/watchers/WatcherStore.js";
import { WebhookTokenStore } from "../src/webhooks/WebhookTokenStore.js";
import { WATCHER_TEMPLATES } from "../src/webhooks/watcherTemplates.js";
import { verifyGithub, verifyStripe } from "../src/webhooks/hmac.js";

function buildStack() {
  const db = new Database(":memory:");
  const watchers = new WatcherStore(db);
  const webhookTokens = new WebhookTokenStore(db, randomBytes(32));
  const authStore = {
    audit: () => {},
  } as unknown as AuthStore;
  const runner = {
    run: (opts: { input: string; sessionId?: string }) => ({
      taskId: `t-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: opts.sessionId ?? "s",
      done: Promise.resolve({ status: "completed" as const, result: "" }),
    }),
  } as unknown as TaskRunner;
  const app = express().use(
    express.json({
      verify: (req: express.Request, _res, buf) => {
        (req as express.Request & { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    }),
  );
  mountWebhookRoutes(app, { runner, watchers, webhookTokens, authStore });
  return { app, watchers, webhookTokens };
}

async function listen(app: express.Express): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
    });
  });
}

describe("watcher templates", () => {
  it("exports a non-empty, well-formed catalogue", () => {
    expect(WATCHER_TEMPLATES.length).toBeGreaterThan(0);
    for (const t of WATCHER_TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(t.name).toBeTruthy();
      expect(t.action).toBeTruthy();
      expect(typeof t.cooldownSeconds).toBe("number");
    }
  });
});

describe("WebhookTokenStore", () => {
  it("issues, verifies bearer, and reveals plaintext HMAC secret", () => {
    const db = new Database(":memory:");
    const store = new WebhookTokenStore(db, randomBytes(32));
    const { bearer, hmacSecret } = store.issue("w1");
    expect(bearer).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(store.verifyBearer("w1", bearer)).toBe(true);
    expect(store.verifyBearer("w1", bearer + "x")).toBe(false);
    expect(store.hmacSecretFor("w1")).toBe(hmacSecret);
  });

  it("rotate replaces tokens; revoke blocks verification", () => {
    const db = new Database(":memory:");
    const store = new WebhookTokenStore(db, randomBytes(32));
    const a = store.issue("w1");
    const b = store.issue("w1");
    expect(store.verifyBearer("w1", a.bearer)).toBe(false);
    expect(store.verifyBearer("w1", b.bearer)).toBe(true);
    store.revoke("w1");
    expect(store.verifyBearer("w1", b.bearer)).toBe(false);
    expect(store.hmacSecretFor("w1")).toBeNull();
  });
});

describe("per-watcher endpoints", () => {
  it("accepts bearer + fires the watcher; rejects bad bearer", async () => {
    const { app, watchers, webhookTokens } = buildStack();
    const w = watchers.create({ name: "w", triggerType: "webhook", action: "do", pattern: "{}" });
    const { bearer } = webhookTokens.issue(w.id);
    const { url, close } = await listen(app);
    try {
      const ok = await fetch(`${url}/hooks/watch/${w.id}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ any: "payload" }),
      });
      expect(ok.status).toBe(202);

      const bad = await fetch(`${url}/hooks/watch/${w.id}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer not-it" },
        body: JSON.stringify({ any: "payload" }),
      });
      expect(bad.status).toBe(401);
    } finally {
      close();
    }
  });

  it("github endpoint accepts a valid X-Hub-Signature-256", async () => {
    const { app, watchers, webhookTokens } = buildStack();
    const w = watchers.create({ name: "gh", triggerType: "webhook", action: "triage", pattern: "{}" });
    const { hmacSecret } = webhookTokens.issue(w.id);

    const body = JSON.stringify({ action: "opened", number: 42 });
    const sig = "sha256=" + createHmac("sha256", hmacSecret).update(body).digest("hex");

    const { url, close } = await listen(app);
    try {
      const res = await fetch(`${url}/hooks/github/${w.id}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": sig },
        body,
      });
      expect(res.status).toBe(202);
    } finally {
      close();
    }
  });

  it("rejects replayed stripe signatures outside tolerance", () => {
    const body = '{"type":"invoice.paid"}';
    const secret = "whsec_test";
    const ts = Math.floor(Date.now() / 1000) - 3600; // 1h old
    const sig = `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
    const r = verifyStripe(body, sig, secret, { toleranceSeconds: 300 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stale");
  });

  it("verifies fresh stripe signatures", () => {
    const body = '{"type":"invoice.paid"}';
    const secret = "whsec_test";
    const ts = Math.floor(Date.now() / 1000);
    const sig = `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
    const r = verifyStripe(body, sig, secret);
    expect(r.ok).toBe(true);
  });

  it("rejects github signatures with wrong secret", () => {
    const body = "{}";
    const realSecret = "real";
    const realSig = "sha256=" + createHmac("sha256", realSecret).update(body).digest("hex");
    const r = verifyGithub(body, realSig, "not-the-secret");
    expect(r.ok).toBe(false);
  });
});
