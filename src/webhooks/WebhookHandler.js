/**
 * Webhook Handler — trigger agent runs via HTTP.
 *
 * POST /hooks/agent — full agent run (queued, returns taskId)
 * POST /hooks/wake  — lightweight heartbeat-style trigger
 *
 * Auth: Bearer token from WEBHOOK_TOKEN env var. Rejects if not set.
 * Rate limit: 30 requests/minute per token.
 */

import { Router } from "express";
import taskQueue from "../core/TaskQueue.js";

const router = Router();

// Rate limiting state
const _rateLimits = new Map(); // token → { count, resetAt }
const RATE_LIMIT = 30;
const RATE_WINDOW = 60_000; // 1 minute

function checkAuth(req, res) {
  const token = process.env.WEBHOOK_TOKEN;
  if (!token) {
    res.status(503).json({ error: "Webhooks not configured. Set WEBHOOK_TOKEN env var." });
    return false;
  }

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
 * POST /hooks/agent — trigger a full agent run.
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
 * POST /hooks/wake — lightweight trigger (heartbeat-style).
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

export default router;
