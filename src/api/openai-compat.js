/**
 * OpenAI-Compatible API — /v1/chat/completions
 *
 * Drop-in replacement for OpenAI API. Routes through TaskRunner as a chat task.
 * Supports both non-streaming and SSE streaming responses.
 *
 * Auth: Bearer token from OPENAI_COMPAT_TOKEN or WEBHOOK_TOKEN env var.
 * Config: openaiCompat.enabled (default false, set OPENAI_COMPAT_ENABLED=true)
 */

import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import taskQueue from "../core/TaskQueue.js";
import eventBus from "../core/EventBus.js";
import { loadTask } from "../storage/TaskStore.js";

const router = Router();

function checkAuth(req, res) {
  const token = process.env.OPENAI_COMPAT_TOKEN || process.env.WEBHOOK_TOKEN;
  if (!token) {
    res.status(503).json({ error: { message: "OpenAI-compat API not configured. Set OPENAI_COMPAT_TOKEN env var.", type: "server_error" } });
    return false;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.slice(7) !== token) {
    res.status(401).json({ error: { message: "Invalid API key.", type: "invalid_request_error" } });
    return false;
  }
  return true;
}

/**
 * POST /v1/chat/completions
 */
router.post("/chat/completions", async (req, res) => {
  if (!checkAuth(req, res)) return;

  const { messages, model, stream = false, max_tokens } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: "messages array is required", type: "invalid_request_error" } });
  }

  // Extract user message (last user message) and system prompt
  let systemContent = "";
  let userContent = "";
  for (const msg of messages) {
    if (msg.role === "system") systemContent += msg.content + "\n";
    if (msg.role === "user") userContent = msg.content;
  }

  const taskInput = systemContent
    ? `[System instruction]: ${systemContent.trim()}\n\n${userContent}`
    : userContent;

  const taskId = uuidv4();

  const task = taskQueue.enqueue({
    input: taskInput,
    channel: "openai-compat",
    sessionId: `compat-${taskId.slice(0, 8)}`,
    model: model || null,
    priority: 5,
    type: "chat",
  });

  if (stream) {
    // SSE streaming
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const completionId = `chatcmpl-${task.id.slice(0, 12)}`;

    const onComplete = (evt) => {
      if (evt.taskId !== task.id) return;
      const finalTask = loadTask(task.id);
      const text = finalTask?.result || "";

      // Send chunks
      const chunk = {
        id: completionId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model || "daemora",
        choices: [{
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: "stop",
        }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      cleanup();
      res.end();
    };

    const onFail = (evt) => {
      if (evt.taskId !== task.id) return;
      const errChunk = {
        id: completionId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model || "daemora",
        choices: [{
          index: 0,
          delta: { content: `Error: ${evt.error || "Task failed"}` },
          finish_reason: "stop",
        }],
      };
      res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      cleanup();
      res.end();
    };

    eventBus.on("task:completed", onComplete);
    eventBus.on("task:failed", onFail);

    const cleanup = () => {
      eventBus.removeListener("task:completed", onComplete);
      eventBus.removeListener("task:failed", onFail);
    };

    req.on("close", cleanup);

    // Timeout after 5 minutes
    setTimeout(() => {
      cleanup();
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: "Timeout" })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }, 300_000);

  } else {
    // Non-streaming — wait for completion
    try {
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Request timed out after 5 minutes"));
        }, 300_000);

        const onComplete = (evt) => {
          if (evt.taskId !== task.id) return;
          clearTimeout(timeout);
          cleanup();
          const finalTask = loadTask(task.id);
          resolve(finalTask?.result || "");
        };

        const onFail = (evt) => {
          if (evt.taskId !== task.id) return;
          clearTimeout(timeout);
          cleanup();
          reject(new Error(evt.error || "Task failed"));
        };

        eventBus.on("task:completed", onComplete);
        eventBus.on("task:failed", onFail);

        var cleanup = () => {
          eventBus.removeListener("task:completed", onComplete);
          eventBus.removeListener("task:failed", onFail);
        };

        req.on("close", () => {
          clearTimeout(timeout);
          cleanup();
        });
      });

      res.json({
        id: `chatcmpl-${task.id.slice(0, 12)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model || "daemora",
        choices: [{
          index: 0,
          message: { role: "assistant", content: result },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: Math.ceil(taskInput.length / 4),
          completion_tokens: Math.ceil(result.length / 4),
          total_tokens: Math.ceil((taskInput.length + result.length) / 4),
        },
      });
    } catch (error) {
      res.status(500).json({ error: { message: error.message, type: "server_error" } });
    }
  }
});

/**
 * GET /v1/models — list available models
 */
router.get("/models", (req, res) => {
  res.json({
    object: "list",
    data: [
      { id: "daemora", object: "model", owned_by: "daemora", created: Math.floor(Date.now() / 1000) },
    ],
  });
});

export default router;
