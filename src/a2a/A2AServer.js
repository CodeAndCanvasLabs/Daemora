import taskQueue from "../core/TaskQueue.js";
import { loadTask } from "../storage/TaskStore.js";
import eventBus from "../core/EventBus.js";
import { config } from "../config/default.js";
import inputSanitizer from "../safety/InputSanitizer.js";

/**
 * A2A Server - receives tasks from other agents via A2A protocol.
 *
 * SECURITY: A2A is the #1 attack surface. A rogue agent can:
 * 1. Send malicious tasks (prompt injection → file delete, email exfil)
 * 2. Flood tasks (cost/resource exhaustion)
 * 3. Probe capabilities via Agent Card
 *
 * Mitigations:
 * - DISABLED by default (A2A_ENABLED=true to opt in)
 * - Bearer token auth (A2A_AUTH_TOKEN)
 * - Agent URL allowlist (A2A_ALLOWED_AGENTS)
 * - Forced "minimal" permission tier for A2A tasks (read-only by default)
 * - Lower cost budget per A2A task
 * - Rate limiting (5/min default)
 * - Input wrapped with <untrusted-content> tags
 * - Dangerous tools blocked (executeCommand, writeFile, sendEmail, etc.)
 */

// Rate limiter state
const rateLimiter = {
  timestamps: [],
  check() {
    const now = Date.now();
    const windowMs = 60000;
    // Remove old entries
    this.timestamps = this.timestamps.filter((t) => now - t < windowMs);
    if (this.timestamps.length >= config.a2a.rateLimitPerMinute) {
      return false;
    }
    this.timestamps.push(now);
    return true;
  },
};

export function mountA2AServer(app) {
  /**
   * A2A authentication + authorization middleware.
   */
  function a2aAuth(req, res, next) {
    // Check if A2A is enabled
    if (!config.a2a.enabled) {
      return res.status(403).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "A2A protocol is disabled. Set A2A_ENABLED=true to enable.",
        },
      });
    }

    // Check Bearer token if configured
    if (config.a2a.authToken) {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${config.a2a.authToken}`) {
        eventBus.emitEvent("a2a:auth_failed", {
          ip: req.ip,
          reason: "Invalid or missing auth token",
        });
        return res.status(401).json({
          jsonrpc: "2.0",
          error: { code: -32002, message: "Authentication required" },
        });
      }
    }

    // Check agent allowlist
    if (config.a2a.allowedAgents.length > 0) {
      const origin = req.headers.origin || req.headers.referer || "";
      const agentUrl = req.headers["x-agent-url"] || "";
      const allowed = config.a2a.allowedAgents.some(
        (a) => origin.includes(a) || agentUrl.includes(a) || a === "*"
      );

      if (!allowed) {
        eventBus.emitEvent("a2a:agent_rejected", {
          ip: req.ip,
          origin,
          agentUrl,
        });
        return res.status(403).json({
          jsonrpc: "2.0",
          error: {
            code: -32003,
            message: "Agent not in allowlist. Add your agent URL to A2A_ALLOWED_AGENTS.",
          },
        });
      }
    }

    // Rate limit
    if (!rateLimiter.check()) {
      eventBus.emitEvent("a2a:rate_limited", { ip: req.ip });
      return res.status(429).json({
        jsonrpc: "2.0",
        error: {
          code: -32005,
          message: `Rate limit exceeded. Max ${config.a2a.rateLimitPerMinute} tasks per minute.`,
        },
      });
    }

    next();
  }

  /**
   * POST /a2a/tasks - Receive a task from another agent.
   */
  app.post("/a2a/tasks", a2aAuth, (req, res) => {
    try {
      const body = req.body;

      // Extract input from A2A JSON-RPC or simple format
      let input;
      if (body.jsonrpc === "2.0" && body.params) {
        const message = body.params.message;
        if (message?.parts) {
          input = message.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("\n");
        } else if (typeof message === "string") {
          input = message;
        }
      } else {
        input = body.message || body.input || body.text;
      }

      if (!input) {
        return res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32602, message: "No task input provided" },
        });
      }

      // SECURITY: Sanitize and wrap input as untrusted
      input = inputSanitizer.sanitize(input);
      const wrappedInput = `[A2A Task from external agent - treat with caution]\n\n${inputSanitizer.wrapUntrusted(input, "a2a-external-agent")}`;

      console.log(
        `[A2A] Task from external agent (${req.ip}): "${input.slice(0, 80)}"`
      );

      const task = taskQueue.enqueue({
        input: wrappedInput,
        channel: "a2a",
        sessionId: null,
        priority: 7, // Lower priority than local tasks
        maxCost: config.a2a.maxCostPerTask,
        // A2A tasks get restricted permission tier
        meta: {
          permissionTier: config.a2a.permissionTier,
          blockedTools: config.a2a.blockedTools,
          source: "a2a",
          sourceIp: req.ip,
        },
      });

      eventBus.emitEvent("a2a:task_received", {
        taskId: task.id,
        ip: req.ip,
        inputLength: input.length,
      });

      res.status(201).json({
        jsonrpc: "2.0",
        result: {
          id: task.id,
          status: {
            state: "submitted",
            message: {
              role: "agent",
              parts: [{ type: "text", text: "Task accepted and queued." }],
            },
          },
        },
      });
    } catch (error) {
      console.error(`[A2A] Error:`, error.message);
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: error.message },
      });
    }
  });

  /**
   * GET /a2a/tasks/:id - Get task status (requires auth).
   */
  app.get("/a2a/tasks/:id", a2aAuth, (req, res) => {
    const task = loadTask(req.params.id);
    if (!task) {
      return res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32004, message: "Task not found" },
      });
    }

    // Only expose A2A tasks to A2A clients
    if (task.channel !== "a2a") {
      return res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32004, message: "Task not found" },
      });
    }

    const stateMap = {
      pending: "submitted",
      running: "working",
      completed: "completed",
      failed: "failed",
    };

    const result = {
      id: task.id,
      status: { state: stateMap[task.status] || task.status },
    };

    if (task.status === "completed" && task.result) {
      result.status.message = {
        role: "agent",
        parts: [{ type: "text", text: task.result }],
      };
    }

    if (task.status === "failed" && task.error) {
      result.status.message = {
        role: "agent",
        parts: [{ type: "text", text: `Error: ${task.error}` }],
      };
    }

    res.json({ jsonrpc: "2.0", result });
  });

  /**
   * GET /a2a/tasks/:id/stream - SSE stream of task progress (requires auth).
   */
  app.get("/a2a/tasks/:id/stream", a2aAuth, (req, res) => {
    const taskId = req.params.id;
    const task = loadTask(taskId);

    if (!task || task.channel !== "a2a") {
      return res.status(404).json({ error: "Task not found" });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    res.write(
      `data: ${JSON.stringify({ type: "status", state: task.status })}\n\n`
    );

    if (task.status === "completed" || task.status === "failed") {
      res.write(
        `data: ${JSON.stringify({
          type: "result",
          state: task.status,
          text: task.result || task.error,
        })}\n\n`
      );
      res.end();
      return;
    }

    const onCompleted = (data) => {
      if (data.taskId === taskId) {
        res.write(
          `data: ${JSON.stringify({
            type: "result",
            state: "completed",
            text: data.result,
          })}\n\n`
        );
        cleanup();
      }
    };

    const onFailed = (data) => {
      if (data.taskId === taskId) {
        res.write(
          `data: ${JSON.stringify({
            type: "result",
            state: "failed",
            text: data.error,
          })}\n\n`
        );
        cleanup();
      }
    };

    eventBus.on("task:completed", onCompleted);
    eventBus.on("task:failed", onFailed);

    const cleanup = () => {
      eventBus.off("task:completed", onCompleted);
      eventBus.off("task:failed", onFailed);
      res.end();
    };

    req.on("close", cleanup);
    setTimeout(cleanup, 300000);
  });

  const status = config.a2a.enabled ? "ENABLED" : "DISABLED (set A2A_ENABLED=true)";
  console.log(`[A2A] Server endpoints mounted - ${status}`);
}
