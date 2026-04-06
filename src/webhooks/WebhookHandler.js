/**
 * Webhook Handler - trigger agent runs via HTTP.
 *
 * POST /hooks/agent - full agent run (queued, returns taskId)
 * POST /hooks/wake  - lightweight heartbeat-style trigger
 *
 * Auth: Bearer token from WEBHOOK_TOKEN env var. Rejects if not set.
 * Rate limit: 30 requests/minute per token.
 */

import { Router } from "express";
import { randomBytes } from "node:crypto";
import { queryOne, run } from "../storage/Database.js";
import taskQueue from "../core/TaskQueue.js";

const router = Router();

// Rate limiting state
const _rateLimits = new Map(); // token → { count, resetAt }
const RATE_LIMIT = 30;
const RATE_WINDOW = 60_000; // 1 minute

/**
 * Get or auto-generate WEBHOOK_TOKEN.
 * Persists to SQLite config_entries so it survives restarts.
 */
function _getOrCreateWebhookToken() {
  if (process.env.WEBHOOK_TOKEN) return process.env.WEBHOOK_TOKEN;
  // Check SQLite config_entries (persisted from previous run)
  try {
    const row = queryOne("SELECT value FROM config_entries WHERE key = 'WEBHOOK_TOKEN'");
    if (row?.value) {
      process.env.WEBHOOK_TOKEN = row.value;
      return row.value;
    }
  } catch {}
  // Auto-generate and persist
  const token = randomBytes(24).toString("hex");
  process.env.WEBHOOK_TOKEN = token;
  try {
    run("INSERT OR REPLACE INTO config_entries (key, value) VALUES ('WEBHOOK_TOKEN', $val)", { $val: token });
  } catch {}
  console.log(`[Webhooks] Auto-generated WEBHOOK_TOKEN (persisted to config)`);
  return token;
}

/** Exported so the UI can show the token. */
export function getWebhookToken() {
  return _getOrCreateWebhookToken();
}

// Auto-generate at import time so it's ready before any health check
_getOrCreateWebhookToken();

function checkAuth(req, res) {
  const token = _getOrCreateWebhookToken();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.slice(7) !== token) {
    res.status(401).json({ error: "Invalid or missing Bearer token." });
    return false;
  }

  // Rate limit check
  const now = Date.now();
  let bucket = _rateLimits.get(token);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW };
    _rateLimits.set(token, bucket);
  }
  bucket.count++;
  if (bucket.count > RATE_LIMIT) {
    res.status(429).json({ error: `Rate limit exceeded (${RATE_LIMIT}/min). Try again later.` });
    return false;
  }

  return true;
}

/**
 * POST /hooks/agent - trigger a full agent run.
 * Body: { message: string, sessionId?: string, model?: string, timeoutSeconds?: number }
 * Returns: { taskId, status: "queued" }
 */
router.post("/agent", (req, res) => {
  if (!checkAuth(req, res)) return;

  const { message, sessionId, model, timeoutSeconds } = req.body || {};
  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }

  const task = taskQueue.enqueue({
    input: message,
    channel: "webhook",
    sessionId: sessionId || `webhook-${Date.now()}`,
    model: model || null,
    priority: 5,
    type: "task",
    timeout: timeoutSeconds ? timeoutSeconds * 1000 : undefined,
  });

  res.status(202).json({
    taskId: task.id,
    status: "queued",
    sessionId: task.sessionId,
  });
});

/**
 * POST /hooks/wake - lightweight trigger (heartbeat-style).
 * Body: { text: string }
 * Returns: { taskId, status: "queued" }
 */
router.post("/wake", (req, res) => {
  if (!checkAuth(req, res)) return;

  const { text } = req.body || {};
  if (!text) {
    return res.status(400).json({ error: "text is required" });
  }

  const task = taskQueue.enqueue({
    input: `[Webhook wake event]: ${text}`,
    channel: "webhook",
    sessionId: `webhook-wake-${Date.now()}`,
    priority: 3,
    type: "task",
  });

  res.status(202).json({
    taskId: task.id,
    status: "queued",
  });
});

/**
 * POST /hooks/watch/:name - trigger a watcher by name.
 * Body: arbitrary JSON payload passed to the watcher's action.
 * Returns: { triggered: true, taskId }
 */
router.post("/watch/:name", async (req, res) => {
  if (!checkAuth(req, res)) return;

  try {
    const { loadWatcherByName, saveWatcher } = await import("../storage/WatcherStore.js");

    const watcher = loadWatcherByName(req.params.name);
    if (!watcher || !watcher.enabled) {
      return res.status(404).json({ error: `Watcher "${req.params.name}" not found or disabled.` });
    }

    // Cooldown check
    if (watcher.cooldownSeconds > 0 && watcher.lastTriggeredAt) {
      const elapsed = (Date.now() - new Date(watcher.lastTriggeredAt).getTime()) / 1000;
      if (elapsed < watcher.cooldownSeconds) {
        return res.status(429).json({ error: "Cooldown active", retryAfter: Math.ceil(watcher.cooldownSeconds - elapsed) });
      }
    }

    // Resolve destinations - use new destinations[] array, fallback to legacy channel/channelMeta
    let destinations = watcher.destinations || [];
    if (destinations.length === 0 && watcher.channel) {
      let meta = watcher.channelMeta;
      if (!meta && watcher.channel !== "webhook" && watcher.channel !== "http") {
        meta = await _resolveDefaultChannelMeta(watcher.channel);
      }
      destinations = [{ channel: watcher.channel, channelMeta: meta }];
    }

    // Enqueue one task per destination (each gets delivered independently)
    const taskIds = [];
    const contextBlock = watcher.context ? `\n\nContext:\n${watcher.context}` : "";
    const input = `[Watcher: ${watcher.name}] ${watcher.action}${contextBlock}\n\nPayload:\n${JSON.stringify(req.body, null, 2)}`;

    if (destinations.length === 0) {
      // No destinations - still run the agent, results stored only
      const task = taskQueue.enqueue({
        input,
        channel: "webhook",
        sessionId: `watcher:${watcher.id}`,
        type: "watcher",
        tenantId: watcher.tenantId,
        priority: 4,
      });
      taskIds.push(task.id);
    } else {
      // First destination runs the agent, others get the result forwarded
      const primary = destinations[0];
      const task = taskQueue.enqueue({
        input,
        channel: primary.channel || "webhook",
        channelMeta: primary.channelMeta || null,
        sessionId: `watcher:${watcher.id}`,
        type: "watcher",
        tenantId: watcher.tenantId,
        priority: 4,
        extraDestinations: destinations.slice(1), // forwarded after completion
      });
      taskIds.push(task.id);
    }

    // Update trigger stats
    watcher.lastTriggeredAt = new Date().toISOString();
    watcher.triggerCount = (watcher.triggerCount || 0) + 1;
    watcher.updatedAt = new Date().toISOString();
    saveWatcher(watcher);

    res.status(202).json({ triggered: true, taskIds, destinations: destinations.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /hooks/event - generic event ingress, match against watcher patterns.
 * Body: arbitrary JSON event payload.
 * Returns: { matched: N, triggered: N }
 */
router.post("/event", async (req, res) => {
  if (!checkAuth(req, res)) return;

  try {
    const { loadEnabledWatchers, saveWatcher } = await import("../storage/WatcherStore.js");

    const watchers = loadEnabledWatchers();
    const payload = req.body || {};
    let matched = 0;
    let triggered = 0;

    for (const watcher of watchers) {
      if (!watcher.pattern) continue;
      if (!_matchesPattern(payload, watcher.pattern)) continue;
      matched++;

      // Cooldown check
      if (watcher.cooldownSeconds > 0 && watcher.lastTriggeredAt) {
        const elapsed = (Date.now() - new Date(watcher.lastTriggeredAt).getTime()) / 1000;
        if (elapsed < watcher.cooldownSeconds) continue;
      }

      // Resolve destinations
      let dests = watcher.destinations || [];
      if (dests.length === 0 && watcher.channel) {
        let meta = watcher.channelMeta;
        if (!meta && watcher.channel !== "webhook" && watcher.channel !== "http") {
          meta = await _resolveDefaultChannelMeta(watcher.channel);
        }
        dests = [{ channel: watcher.channel, channelMeta: meta }];
      }
      const primary = dests[0] || { channel: "webhook", channelMeta: null };

      taskQueue.enqueue({
        input: `[Watcher: ${watcher.name}] ${watcher.action}${watcher.context ? "\n\nContext:\n" + watcher.context : ""}\n\nPayload:\n${JSON.stringify(payload, null, 2)}`,
        channel: primary.channel || "webhook",
        channelMeta: primary.channelMeta || null,
        sessionId: `watcher:${watcher.id}`,
        type: "watcher",
        tenantId: watcher.tenantId,
        priority: 4,
        extraDestinations: dests.slice(1),
      });

      watcher.lastTriggeredAt = new Date().toISOString();
      watcher.triggerCount = (watcher.triggerCount || 0) + 1;
      watcher.updatedAt = new Date().toISOString();
      saveWatcher(watcher);
      triggered++;
    }

    res.status(200).json({ matched, triggered });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Match payload against a watcher pattern (AND logic).
 * Pattern values: string equality, or regex if starts with "/".
 */
function _matchesPattern(payload, pattern) {
  for (const [key, expected] of Object.entries(pattern)) {
    const actual = payload[key];
    if (actual === undefined) return false;

    if (typeof expected === "string" && expected.startsWith("/")) {
      // Regex match: "/pattern/flags"
      const lastSlash = expected.lastIndexOf("/");
      const regexBody = lastSlash > 0 ? expected.slice(1, lastSlash) : expected.slice(1);
      const flags = lastSlash > 0 ? expected.slice(lastSlash + 1) : "";
      try {
        const re = new RegExp(regexBody, flags);
        if (!re.test(String(actual))) return false;
      } catch {
        if (String(actual) !== expected) return false;
      }
    } else {
      if (String(actual) !== String(expected)) return false;
    }
  }
  return true;
}

/**
 * Resolve default channelMeta for a running channel.
 * Used when a watcher specifies a channel but has no stored channelMeta.
 * Looks up the most recent message's routing info from the channel.
 */
async function _resolveDefaultChannelMeta(channelName) {
  try {
    const channelRegistry = (await import("../channels/index.js")).default;
    const instance = channelRegistry.get(channelName);
    if (!instance || !instance.running) return null;

    // Check for a default/fallback channel ID from config or recent activity
    // Discord: look for DISCORD_DEFAULT_CHANNEL_ID or first guild text channel
    // Look for cached routing meta from channel_routing
    const { queryOne } = await import("../storage/Database.js");

    const row = queryOne(
      "SELECT meta FROM channel_routing WHERE channel = $ch ORDER BY rowid DESC LIMIT 1",
      { $ch: channelName }
    );
    if (row?.meta) {
      try {
        const meta = JSON.parse(row.meta);
        if (meta.channelId || meta.chatId) return { ...meta, channel: channelName };
      } catch {}
    }

    // Fallback: check env vars for default channel IDs
    const envKey = `${channelName.toUpperCase()}_DEFAULT_CHANNEL_ID`;
    if (process.env[envKey]) {
      return { channelId: process.env[envKey], channel: channelName };
    }

    return null;
  } catch {
    return null;
  }
}

export default router;
