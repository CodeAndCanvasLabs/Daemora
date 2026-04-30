/**
 * WebhookHandler — HTTP ingress for external events, with per-watcher
 * bearer tokens + optional HMAC signature verification.
 *
 * Routes (all under `mountPath`, default `/hooks`):
 *   POST /agent              enqueue a full agent turn     [auth: user session]
 *   POST /wake               lightweight agent trigger      [auth: user session]
 *   POST /watch/:id          fire one watcher by id/name    [auth: bearer OR HMAC]
 *   POST /github/:id         GitHub-shaped HMAC ingress    [auth: X-Hub-Signature-256]
 *   POST /stripe/:id         Stripe-shaped HMAC ingress     [auth: Stripe-Signature]
 *   POST /event              fan-out to all matching        [auth: user session]
 *
 * /agent, /wake, /event are user-facing — authenticated by the normal
 * session JWT (requireAuth middleware upstream). Per-watcher endpoints
 * use the watcher's own tokens so external providers don't need the
 * user's session.
 *
 * Per-watcher auth: caller can present EITHER a valid bearer OR a valid
 * HMAC signature. Mismatch on both → 401. Missing both → 401.
 *
 * Rate limit: per watcher id (60/min). Prevents a compromised bearer
 * from burning through API quota before the user can rotate.
 */

import type { Express, Request, Response } from "express";

import type { TaskRunner } from "../core/TaskRunner.js";
import type { AuthStore } from "../auth/AuthStore.js";
import { verifyGeneric, verifyGithub, verifyStripe } from "./hmac.js";
import type { WebhookTokenStore } from "./WebhookTokenStore.js";
import { createLogger } from "../util/logger.js";
import type { WatcherRow, WatcherStore } from "../watchers/WatcherStore.js";

const log = createLogger("webhooks");

const PER_WATCHER_RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

export interface WebhookDeps {
  readonly runner: TaskRunner;
  readonly watchers: WatcherStore;
  readonly webhookTokens: WebhookTokenStore;
  readonly authStore: AuthStore;
}

export function mountWebhookRoutes(app: Express, deps: WebhookDeps, mountPath = "/hooks"): void {
  const perWatcherBuckets = new Map<string, { count: number; resetAt: number }>();

  const touchRateLimit = (watcherId: string): boolean => {
    const now = Date.now();
    let b = perWatcherBuckets.get(watcherId);
    if (!b || now > b.resetAt) {
      b = { count: 0, resetAt: now + RATE_WINDOW_MS };
      perWatcherBuckets.set(watcherId, b);
    }
    b.count++;
    return b.count <= PER_WATCHER_RATE_LIMIT;
  };

  // User-facing endpoints rely on upstream `requireAuth` middleware —
  // they sit under /hooks but the auth gate runs before us.
  app.post(`${mountPath}/agent`, (req, res) => {
    if (!req.auth) return res.status(401).json({ error: "Unauthorized" });
    const body = req.body as { message?: string; sessionId?: string; model?: string } | undefined;
    const message = body?.message;
    if (!message || typeof message !== "string") return res.status(400).json({ error: "`message` required" });
    const handle = deps.runner.run({
      input: message,
      channel: "webhook",
      ...(body?.sessionId ? { sessionId: body.sessionId } : { sessionId: "main" }),
      ...(body?.model ? { model: body.model } : {}),
    });
    res.status(202).json({ taskId: handle.taskId, sessionId: handle.sessionId, status: "queued" });
  });

  app.post(`${mountPath}/wake`, (req, res) => {
    if (!req.auth) return res.status(401).json({ error: "Unauthorized" });
    const body = req.body as { text?: string } | undefined;
    const text = body?.text;
    if (!text || typeof text !== "string") return res.status(400).json({ error: "`text` required" });
    const handle = deps.runner.run({
      input: `[Webhook wake] ${text}`,
      channel: "webhook",
      sessionId: "main",
    });
    res.status(202).json({ taskId: handle.taskId, status: "queued" });
  });

  app.post(`${mountPath}/event`, (req, res) => {
    if (!req.auth) return res.status(401).json({ error: "Unauthorized" });
    const payload = (req.body ?? {}) as Record<string, unknown>;
    const all = deps.watchers.list().filter((w) => w.enabled && w.triggerType === "webhook");
    let matched = 0;
    let triggered = 0;
    const taskIds: string[] = [];
    for (const watcher of all) {
      const pattern = parsePattern(watcher.pattern);
      if (!matchesPattern(payload, pattern)) continue;
      matched++;
      if (cooldownLeft(watcher) > 0) continue;
      const taskId = fireWatcher(deps, watcher, payload);
      deps.watchers.markTriggered(watcher.id);
      taskIds.push(taskId);
      triggered++;
    }
    res.json({ matched, triggered, taskIds });
  });

  // ── Per-watcher endpoints (external providers) ──────────────────────────

  app.post(`${mountPath}/watch/:id`, (req, res) => {
    const watcher = resolveWatcher(deps.watchers, req.params.id ?? "");
    if (!watcher) return res.status(404).json({ error: "Watcher not found" });
    if (!watcher.enabled) return res.status(403).json({ error: "Watcher disabled" });
    if (!touchRateLimit(watcher.id)) return res.status(429).json({ error: "Rate limited" });

    const authed = authenticateWatcher({
      req,
      watcher,
      deps,
      provider: "generic",
    });
    if (!authed.ok) {
      deps.authStore.audit({ userId: "webhook", event: "login.fail", ip: req.socket.remoteAddress ?? null, detail: `watcher=${watcher.id} reason=${authed.reason}` });
      return res.status(401).json({ error: "Unauthorized", reason: authed.reason });
    }
    if (cooldownLeft(watcher) > 0) return res.status(429).json({ error: "Cooldown", retryAfter: cooldownLeft(watcher) });
    const taskId = fireWatcher(deps, watcher, req.body);
    deps.watchers.markTriggered(watcher.id);
    res.status(202).json({ triggered: true, taskId, watcher: watcher.name });
  });

  app.post(`${mountPath}/github/:id`, (req, res) => {
    const watcher = resolveWatcher(deps.watchers, req.params.id ?? "");
    if (!watcher || !watcher.enabled) return res.status(404).json({ error: "Not found" });
    if (!touchRateLimit(watcher.id)) return res.status(429).json({ error: "Rate limited" });
    const authed = authenticateWatcher({ req, watcher, deps, provider: "github" });
    if (!authed.ok) {
      deps.authStore.audit({ userId: "webhook", event: "login.fail", ip: req.socket.remoteAddress ?? null, detail: `github watcher=${watcher.id} reason=${authed.reason}` });
      return res.status(401).json({ error: "Unauthorized", reason: authed.reason });
    }
    if (cooldownLeft(watcher) > 0) return res.status(429).json({ error: "Cooldown" });
    const taskId = fireWatcher(deps, watcher, req.body);
    deps.watchers.markTriggered(watcher.id);
    res.status(202).json({ triggered: true, taskId });
  });

  app.post(`${mountPath}/stripe/:id`, (req, res) => {
    const watcher = resolveWatcher(deps.watchers, req.params.id ?? "");
    if (!watcher || !watcher.enabled) return res.status(404).json({ error: "Not found" });
    if (!touchRateLimit(watcher.id)) return res.status(429).json({ error: "Rate limited" });
    const authed = authenticateWatcher({ req, watcher, deps, provider: "stripe" });
    if (!authed.ok) {
      deps.authStore.audit({ userId: "webhook", event: "login.fail", ip: req.socket.remoteAddress ?? null, detail: `stripe watcher=${watcher.id} reason=${authed.reason}` });
      return res.status(401).json({ error: "Unauthorized", reason: authed.reason });
    }
    if (cooldownLeft(watcher) > 0) return res.status(429).json({ error: "Cooldown" });
    const taskId = fireWatcher(deps, watcher, req.body);
    deps.watchers.markTriggered(watcher.id);
    res.status(202).json({ triggered: true, taskId });
  });

  log.info({ mountPath, routes: ["agent", "wake", "event", "watch/:id", "github/:id", "stripe/:id"] }, "webhook routes mounted");
}

// ── auth for per-watcher endpoints ─────────────────────────────────────────

type AuthOutcome = { ok: true } | { ok: false; reason: "no_token_for_watcher" | "bad_bearer" | "bad_hmac" | "missing" | "malformed" | "mismatch" | "stale" };

function authenticateWatcher(opts: { req: Request; watcher: WatcherRow; deps: WebhookDeps; provider: "github" | "stripe" | "generic" }): AuthOutcome {
  const { req, watcher, deps, provider } = opts;

  // Watcher must have tokens issued. If not, reject — prevents accepting
  // any request to an unconfigured watcher.
  const row = deps.webhookTokens.getRow(watcher.id);
  if (!row || row.revokedAt !== null) return { ok: false, reason: "no_token_for_watcher" };

  // 1. Bearer path (generic endpoint + optional header on provider endpoints)
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const bearer = auth.slice(7);
    if (deps.webhookTokens.verifyBearer(watcher.id, bearer)) return { ok: true };
    // fall through — maybe HMAC is also present
  }

  // 2. HMAC path
  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? "";
  const secret = deps.webhookTokens.hmacSecretFor(watcher.id);
  if (!secret) {
    // can't verify HMAC without the secret — bail with bad_bearer since bearer also failed
    return { ok: false, reason: "bad_bearer" };
  }

  if (provider === "github") {
    const sig = headerOne(req, "x-hub-signature-256");
    const r = verifyGithub(rawBody, sig, secret);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }
  if (provider === "stripe") {
    const sig = headerOne(req, "stripe-signature");
    const r = verifyStripe(rawBody, sig, secret);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }
  // generic: check X-Webhook-Signature (+ optional X-Webhook-Timestamp)
  const sig = headerOne(req, "x-webhook-signature");
  const tsHeaderRaw = headerOne(req, "x-webhook-timestamp");
  const r = verifyGeneric(rawBody, sig, secret, tsHeaderRaw ? { timestampHeader: tsHeaderRaw } : {});
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

function headerOne(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}

// ── helpers (pattern / cooldown / firing — unchanged) ──────────────────────

function resolveWatcher(store: WatcherStore, idOrName: string): WatcherRow | null {
  const byId = store.get(idOrName);
  if (byId) return byId;
  return store.list().find((w) => w.name === idOrName) ?? null;
}

function cooldownLeft(watcher: WatcherRow): number {
  const parsed = parsePattern(watcher.pattern);
  const cooldown = typeof parsed.__cooldownSeconds === "number" ? parsed.__cooldownSeconds : 0;
  if (cooldown <= 0 || !watcher.lastTriggeredAt) return 0;
  const elapsed = (Date.now() - watcher.lastTriggeredAt) / 1000;
  return elapsed < cooldown ? Math.ceil(cooldown - elapsed) : 0;
}

interface ParsedPattern {
  readonly [key: string]: unknown;
  readonly __cooldownSeconds?: number;
}

function parsePattern(raw: string): ParsedPattern {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return typeof obj === "object" && obj !== null ? (obj as ParsedPattern) : {};
  } catch {
    return {};
  }
}

function matchesPattern(payload: Record<string, unknown>, pattern: ParsedPattern): boolean {
  for (const [key, expected] of Object.entries(pattern)) {
    if (key.startsWith("__")) continue;
    const actual = payload[key];
    if (actual === undefined) return false;
    if (typeof expected === "string" && expected.startsWith("/") && expected.length > 1) {
      const lastSlash = expected.lastIndexOf("/");
      const body = lastSlash > 0 ? expected.slice(1, lastSlash) : expected.slice(1);
      const flags = lastSlash > 0 ? expected.slice(lastSlash + 1) : "";
      try {
        const re = new RegExp(body, flags);
        if (!re.test(String(actual))) return false;
        continue;
      } catch {
        if (String(actual) !== expected) return false;
        continue;
      }
    }
    if (String(actual) !== String(expected)) return false;
  }
  return true;
}

function fireWatcher(deps: WebhookDeps, watcher: WatcherRow, payload: unknown): string {
  const input = `[Watcher: ${watcher.name}] ${watcher.action}\n\nPayload:\n${JSON.stringify(payload, null, 2)}`;
  const handle = deps.runner.run({
    input,
    channel: watcher.channel ?? "webhook",
    sessionId: "main",
  });
  return handle.taskId;
}
