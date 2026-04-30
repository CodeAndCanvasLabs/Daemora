/**
 * /api/chat + /api/tasks/:id/stream — task-based chat matching the
 * daemora-ui flow:
 *
 *   1. POST /api/chat  { input, sessionId }  →  { taskId }
 *   2. GET  /api/tasks/:id/stream            →  EventSource (SSE)
 *
 * Events the UI listens for:
 *   task:state    { status, result?, error? }
 *   model:called  { iteration }
 *   text:delta    { delta }
 *   tool:before   { tool_name, params }
 *   tool:after    { tool_name, duration?, error? }
 *   agent:spawned { role }
 */

import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, extname } from "node:path";
import type { Express, Request, Response } from "express";
import { z } from "zod";

import { ValidationError } from "../../util/errors.js";
import { createLogger } from "../../util/logger.js";
import type { ServerDeps } from "../index.js";

const log = createLogger("chat");

/**
 * Inline attachment sent with a chat turn. Binary payload is base64 so
 * the existing JSON endpoint keeps working (the UI upload path pre-
 * encodes with FileReader). 25 MB raw cap per file — enough for voice
 * notes and screenshots, short of overloading model context.
 */
const chatAttachment = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(128),
  /** base64-encoded bytes. */
  base64: z.string().min(1),
  kind: z.enum(["image", "audio", "video", "document", "file"]).optional(),
});

const chatRequest = z.object({
  input: z.string().min(1).max(50_000),
  sessionId: z.string().min(1).max(200).optional(),
  model: z.string().optional(),
  // Voice turns set this to true so the agent knows to answer in
  // short, spoken, markdown-free style instead of producing tables /
  // code blocks the TTS would have to read literally.
  voiceMode: z.boolean().optional(),
  attachments: z.array(chatAttachment).max(10).optional(),
});

interface TrackedTask {
  readonly id: string;
  readonly sessionId: string;
  readonly emitter: EventEmitter;
  status: "pending" | "running" | "completed" | "failed";
  result?: string;
  error?: string;
}

const activeTasks = new Map<string, TrackedTask>();

export function mountChatRoutes(app: Express, deps: ServerDeps): void {
  app.post("/api/chat", (req: Request, res: Response) => {
    const body = chatRequest.safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.message);

    // Materialise any base64 attachments to the inbox directory so the
    // AttachmentProcessor sees them as regular file paths. One-way: we
    // never send these bytes back to the client.
    const resolvedAttachments = (body.data.attachments ?? []).map((a) => {
      const bytes = Buffer.from(a.base64, "base64");
      const inbox = join(deps.cfg.env.dataDir, "inbox");
      try { mkdirSync(inbox, { recursive: true }); } catch { /* already exists */ }
      const safeName = a.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
      const ext = extname(safeName) || extFor(a.mimeType);
      const saved = join(inbox, `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`);
      writeFileSync(saved, bytes);
      const kind = a.kind ?? inferKind(a.mimeType);
      return {
        kind,
        path: saved,
        mimeType: a.mimeType,
        filename: safeName,
        size: bytes.byteLength,
      } as const;
    });

    // Use send() instead of run(): if a loop is already running on this
    // session, the new input is enqueued in the pending queue and the
    // running loop absorbs it at its next safe boundary (between turns).
    // No parallel tasks per session — one continuous conversation.
    // EventEmitter default listener cap is 10. Multiple SSE subscribers
    // (e.g. browser tab + retry + dev-tools) attach `done` listeners to
    // the same long-running task; bump the cap to silence the leak
    // warning. We still cleanup in `req.on("close")`, so this is just
    // headroom for legitimate concurrent subscribers, not unbounded.
    const emitter = new EventEmitter();
    emitter.setMaxListeners(64);
    const sendResult = deps.runner.send({
      input: body.data.input,
      ...(body.data.sessionId ? { sessionId: body.data.sessionId } : {}),
      ...(body.data.model ? { model: body.data.model } : {}),
      ...(body.data.voiceMode ? { voiceMode: true } : {}),
      ...(resolvedAttachments.length > 0 ? { attachments: resolvedAttachments } : {}),
      onLocal: (event, data) => emitter.emit("sse", event, data),
    });

    if (sendResult.mode === "injected") {
      // Loop already running on this session — input is queued. Tell the
      // client to subscribe to the existing task's SSE stream so it sees
      // the agent's response to the injected input as it arrives.
      res.json({ taskId: sendResult.taskId, sessionId: sendResult.sessionId, mode: "injected" });
      return;
    }

    // mode === "fresh" → new loop spawned for this session.
    const tracked: TrackedTask = {
      id: sendResult.taskId,
      sessionId: sendResult.sessionId,
      emitter,
      status: "pending",
    };
    activeTasks.set(sendResult.taskId, tracked);

    res.json({ taskId: sendResult.taskId, sessionId: sendResult.sessionId, mode: "fresh" });

    sendResult.done!
      .then((terminal) => {
        tracked.status = terminal.status;
        if (terminal.result !== undefined) tracked.result = terminal.result;
        if (terminal.error !== undefined) tracked.error = terminal.error;
        emitter.emit("done");
      })
      .catch((e: unknown) => {
        tracked.status = "failed";
        tracked.error = (e as Error).message ?? String(e);
        log.error({ taskId: sendResult.taskId, err: tracked.error }, "task crashed");
        emitter.emit("done");
      })
      .finally(() => {
        setTimeout(() => activeTasks.delete(sendResult.taskId), 60_000).unref();
      });
  });

  app.get("/api/tasks/:id/stream", (req: Request, res: Response) => {
    const taskId = req.params.id;
    if (!taskId) throw new ValidationError("Missing task id");
    const task = activeTasks.get(taskId);

    if (!task) {
      res.writeHead(200, sseHeaders());
      sendSSE(res, "task:state", {
        status: "completed",
        result: "(task not found or already finished)",
      });
      res.end();
      return;
    }

    res.writeHead(200, sseHeaders());

    if (task.status === "completed" || task.status === "failed") {
      sendSSE(res, "task:state", {
        status: task.status,
        ...(task.result ? { result: task.result } : {}),
        ...(task.error ? { error: task.error } : {}),
      });
      res.end();
      return;
    }

    const onEvent = (event: string, data: unknown) => sendSSE(res, event, data);
    task.emitter.on("sse", onEvent);

    const cleanup = () => task.emitter.off("sse", onEvent);
    req.on("close", cleanup);
    task.emitter.once("done", () => {
      cleanup();
      res.end();
    });
  });

  app.get("/api/sessions/:id/stream", (req: Request, res: Response) => {
    res.writeHead(200, sseHeaders());
    req.on("close", () => res.end());
  });
}

function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  };
}

function sendSSE(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function inferKind(mime: string): "image" | "audio" | "video" | "document" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (
    mime === "application/pdf" ||
    mime.includes("officedocument") ||
    mime === "application/msword" ||
    mime === "application/vnd.ms-excel"
  ) {
    return "document";
  }
  return "file";
}

function extFor(mime: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/mp4": ".m4a",
    "audio/webm": ".webm",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
  };
  return map[mime] ?? "";
}
