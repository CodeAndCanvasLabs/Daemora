/**
 * /api/sessions — chat session CRUD.
 *
 * - GET    /api/sessions          list, most-recently-updated first
 * - GET    /api/sessions/:id      full history (oldest-first)
 * - PATCH  /api/sessions/:id      rename
 * - DELETE /api/sessions/:id      hard delete (cascades messages)
 */

import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve as pathResolve, sep as pathSep } from "node:path";

import type { Express, Request, Response } from "express";
import { z } from "zod";

import { NotFoundError, ValidationError } from "../../util/errors.js";
import type { AttachmentMeta } from "../../memory/SessionStore.js";
import type { ServerDeps } from "../index.js";

const idParam = z.object({ id: z.string().min(1).max(200) });

/**
 * AI SDK stores assistant content as `string | ContentPart[]`.
 * The UI expects plain strings. Normalize here so the UI never
 * has to deal with SDK internals.
 */
function normalizeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // Extract only text parts — tool-call and tool-result are internal
    return content
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string") return p.text;
        // Skip tool-call, tool-result — they're internal, not for display
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content ?? "");
}

/** Check if a message is purely tool-internal (no user-visible text). */
function isToolOnlyMessage(msg: { role: string; content: unknown }): boolean {
  if (msg.role === "tool") return true;
  if (!Array.isArray(msg.content)) return false;
  // If ALL parts are tool-call or tool-result, hide the message
  return (msg.content as { type?: string }[]).every(
    (p) => p.type === "tool-call" || p.type === "tool-result",
  );
}
const renameBody = z.object({ title: z.string().min(1).max(200) });

/** Parse :id out of req.params — keeps exactOptionalPropertyTypes happy. */
function readId(req: Request): string {
  const parsed = idParam.safeParse(req.params);
  if (!parsed.success) throw new ValidationError("Invalid session id");
  return parsed.data.id;
}

const createBody = z.object({
  sessionId: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(200).optional(),
});

export function mountSessionRoutes(app: Express, deps: ServerDeps): void {
  app.get("/api/sessions", (_req: Request, res: Response) => {
    res.json({ sessions: deps.sessions.listSessions() });
  });

  /** Create or ensure a session exists. UI calls this with { sessionId: "main" }. */
  app.post("/api/sessions", (req: Request, res: Response) => {
    const body = createBody.safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.message);

    const id = body.data.sessionId;
    if (id) {
      const existing = deps.sessions.getSession(id);
      if (existing) {
        res.json({ session: existing, created: false });
        return;
      }
      const session = deps.sessions.createSessionWithId(id, { title: body.data.title ?? "Chat" });
      res.json({ session, created: true });
    } else {
      const session = deps.sessions.createSession({ title: body.data.title ?? "New chat" });
      res.json({ session, created: true });
    }
  });

  app.get("/api/sessions/:id", (req: Request, res: Response) => {
    const id = readId(req);
    const session = deps.sessions.getSession(id);
    if (!session) throw new NotFoundError(`Session not found: ${id}`);
    const rows = deps.sessions.getHistoryRows(id, { limit: 500 });
    // Filter out tool-internal messages and normalize content to strings.
    // The UI should only see user messages + assistant text responses.
    // Each row may carry an attachments sidecar (user-sent files) that
    // we echo back so the composer thumbnails re-render on reload.
    const normalized = rows
      .map((r) => {
        const content = JSON.parse(r.contentJson) as { role: string; content: unknown };
        return { row: r, content };
      })
      .filter(({ content }) => !isToolOnlyMessage(content))
      .map(({ row, content }) => {
        const text = normalizeContent(content.content);
        const attachments = row.attachmentsJson
          ? (JSON.parse(row.attachmentsJson) as AttachmentMeta[])
          : undefined;
        const hasContent = text.trim().length > 0 || (attachments && attachments.length > 0);
        if (!hasContent) return null;
        return {
          role: content.role,
          content: text,
          timestamp: new Date(row.createdAt).toISOString(),
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);
    res.json({ session, messages: normalized });
  });

  // ── /api/file — serve a file the UI needs to render inline ──
  // Scoped to prevent the endpoint from being used to exfiltrate vault
  // files, DBs, or arbitrary disk contents. Auth is already enforced by
  // the global requireAuth middleware (loopback token via ?token= for
  // <img src=> compatibility).
  //
  // Allowed paths:
  //   - anywhere under `<dataDir>/inbox/`   — user-sent attachments
  //   - anywhere under `<dataDir>/outputs/` — agent-generated artefacts
  //   - tmpdir files whose basename starts with `daemora-`
  //     (legacy path for image-gen output — still writable by the
  //     agent via explicit outputPath, and a transitional whitelist
  //     for PNGs already generated before the outputs/ switch)
  app.get("/api/file", (req: Request, res: Response) => {
    const raw = typeof req.query["path"] === "string" ? req.query["path"] : "";
    if (!raw) throw new ValidationError("missing path");
    const abs = pathResolve(raw);
    const dataDir = deps.cfg.env.dataDir;
    const dataRoots = [
      pathResolve(dataDir, "inbox"),
      pathResolve(dataDir, "outputs"),
    ];
    const tmpRoot = pathResolve(tmpdir());
    const underData = dataRoots.some((root) => abs === root || abs.startsWith(root + pathSep));
    const underTmpDaemora =
      (abs === tmpRoot || abs.startsWith(tmpRoot + pathSep))
      && basename(abs).startsWith("daemora-");
    if (!underData && !underTmpDaemora) {
      throw new ValidationError("path outside allowed roots");
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new NotFoundError("file not found");
    }
    res.sendFile(abs);
  });

  app.patch("/api/sessions/:id", (req: Request, res: Response) => {
    const id = readId(req);
    const body = renameBody.safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.message);
    const ok = deps.sessions.renameSession(id, body.data.title);
    if (!ok) throw new NotFoundError(`Session not found: ${id}`);
    res.json({ id, title: body.data.title });
  });

  app.delete("/api/sessions/:id", (req: Request, res: Response) => {
    const id = readId(req);
    const removed = deps.sessions.deleteSession(id);
    if (!removed) throw new NotFoundError(`Session not found: ${id}`);
    res.json({ id, removed: true });
  });
}
