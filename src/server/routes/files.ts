/**
 * /api/file-projects — Files feature CRUD + image scan status.
 *
 * Endpoints:
 *   GET    /api/file-projects                              — list all projects
 *   POST   /api/file-projects                              — create
 *   GET    /api/file-projects/:slug                        — read one (with files)
 *   DELETE /api/file-projects/:slug                        — delete (recursive)
 *   POST   /api/file-projects/:slug/files                  — upload (base64 in JSON)
 *   DELETE /api/file-projects/:slug/files/:fileId          — remove file
 *   GET    /api/file-projects/:slug/files/:fileId/raw      — download original (UI preview)
 *   GET    /api/file-projects/:slug/files/:fileId/filer    — fetch filer markdown
 *
 * URL prefix is `/api/file-projects` (not `/api/projects`) so it doesn't
 * collide with the agent's task-planning ProjectStore in src/projects/,
 * which is a different concept.
 *
 * Upload payload mirrors the chat-attachment shape: base64 + filename +
 * mimeType. Express's body limit is 40 MB (server/index.ts) which is
 * ~25-30 MB of actual bytes after base64 expansion.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { Express, Request, Response } from "express";
import { z } from "zod";

import {
  type FileProjectStore,
  inferKindFromMime,
  initialScanStatus,
  slugify,
} from "../../files/FileProjectStore.js";
import type { ScanQueue } from "../../files/scanQueue.js";
import { NotFoundError, ValidationError } from "../../util/errors.js";

const createBody = z.object({
  name: z.string().min(1).max(120),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  description: z.string().max(2_000).optional(),
});

const patchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  description: z.string().max(2_000).optional(),
});

/**
 * File-rename payload. We only let users change the user-facing
 * `filename` — the on-disk path stays opaque (with its random suffix)
 * to avoid collisions and keep references stable across renames.
 * The filename is what surfaces to the agent in list_gallery_projects,
 * so users can name files semantically (`logo.png`, `bg.jpg`) instead
 * of the auto-suffixed upload name.
 */
const fileRenameBody = z.object({
  filename: z.string().min(1).max(200),
});

const uploadBody = z.object({
  filename: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(120),
  base64: z.string().min(1),
});

export interface FilesRoutesDeps {
  readonly store: FileProjectStore;
  readonly scanQueue: ScanQueue;
}

export function mountFilesRoutes(app: Express, deps: FilesRoutesDeps): void {
  app.get("/api/file-projects", (_req: Request, res: Response) => {
    res.json({ projects: deps.store.list() });
  });

  app.post("/api/file-projects", (req: Request, res: Response) => {
    const body = createBody.safeParse(req.body ?? {});
    if (!body.success) throw new ValidationError(body.error.message);
    try {
      const project = deps.store.create({
        name: body.data.name.trim(),
        ...(body.data.color ? { color: body.data.color } : {}),
        ...(body.data.description ? { description: body.data.description.trim() } : {}),
      });
      res.status(201).json({ project });
    } catch (e) {
      throw new ValidationError((e as Error).message);
    }
  });

  app.patch("/api/file-projects/:slug", (req: Request, res: Response) => {
    const slug = parseSlug(req);
    const body = patchBody.safeParse(req.body ?? {});
    if (!body.success) throw new ValidationError(body.error.message);
    const updated = deps.store.updateMeta(slug, {
      ...(body.data.name !== undefined ? { name: body.data.name.trim() } : {}),
      ...(body.data.color !== undefined ? { color: body.data.color } : {}),
      ...(body.data.description !== undefined ? { description: body.data.description.trim() } : {}),
    });
    if (!updated) throw new NotFoundError(`Project '${slug}' not found.`);
    res.json({ project: updated });
  });

  app.get("/api/file-projects/:slug", (req: Request, res: Response) => {
    const slug = parseSlug(req);
    const project = deps.store.read(slug);
    if (!project) throw new NotFoundError(`Project '${slug}' not found.`);
    res.json({ project });
  });

  app.delete("/api/file-projects/:slug", (req: Request, res: Response) => {
    const slug = parseSlug(req);
    const ok = deps.store.delete(slug);
    if (!ok) throw new NotFoundError(`Project '${slug}' not found.`);
    res.json({ ok: true });
  });

  app.post("/api/file-projects/:slug/files", (req: Request, res: Response) => {
    const slug = parseSlug(req);
    const project = deps.store.read(slug);
    if (!project) throw new NotFoundError(`Project '${slug}' not found.`);

    const body = uploadBody.safeParse(req.body ?? {});
    if (!body.success) throw new ValidationError(body.error.message);

    // Compute a collision-free relative path. Original filename is
    // sanitised so users can't escape the project dir with `../`.
    const safeName = body.data.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
    const ext = extname(safeName) || extFor(body.data.mimeType);
    const stem = safeName.replace(/\.[^.]*$/, "") || "file";
    const unique = `${stem}-${randomUUID().slice(0, 8)}${ext}`;
    const relPath = `files/${unique}`;
    const absPath = deps.store.resolveAbs(slug, relPath);

    let bytes: Buffer;
    try {
      bytes = Buffer.from(body.data.base64, "base64");
    } catch {
      throw new ValidationError("Invalid base64 payload.");
    }
    if (bytes.byteLength === 0) throw new ValidationError("Empty file.");

    mkdirSync(deps.store.resolveAbs(slug, "files"), { recursive: true });
    writeFileSync(absPath, bytes);

    const kind = inferKindFromMime(body.data.mimeType, safeName);
    const record = deps.store.addFile(slug, {
      kind,
      filename: safeName,
      path: relPath,
      mimeType: body.data.mimeType,
      size: bytes.byteLength,
      scanStatus: initialScanStatus(kind),
    });

    if (kind === "image") {
      // Async scan — UI polls for status.
      deps.scanQueue.enqueue(slug, record.id);
    }

    res.status(201).json({ file: record });
  });

  app.patch("/api/file-projects/:slug/files/:fileId", (req: Request, res: Response) => {
    const { slug, file } = resolveFile(deps.store, req);
    const body = fileRenameBody.safeParse(req.body ?? {});
    if (!body.success) throw new ValidationError(body.error.message);
    const safeName = body.data.filename.replace(/[^A-Za-z0-9._\- ]/g, "_").trim().slice(0, 120);
    if (!safeName) throw new ValidationError("Filename cannot be empty after sanitisation.");
    const updated = deps.store.updateFile(slug, file.id, { filename: safeName });
    if (!updated) throw new NotFoundError("File vanished mid-rename.");
    res.json({ file: updated });
  });

  app.delete("/api/file-projects/:slug/files/:fileId", (req: Request, res: Response) => {
    const slug = parseSlug(req);
    const fileId = (req.params.fileId ?? "").trim();
    if (!fileId) throw new ValidationError("fileId is required.");
    const ok = deps.store.removeFile(slug, fileId);
    if (!ok) throw new NotFoundError(`File '${fileId}' not found.`);
    res.json({ ok: true });
  });

  app.get("/api/file-projects/:slug/files/:fileId/raw", (req: Request, res: Response) => {
    const { slug, file } = resolveFile(deps.store, req);
    const abs = deps.store.resolveAbs(slug, file.path);
    if (!existsSync(abs)) throw new NotFoundError("File missing on disk.");
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Content-Length", String(statSync(abs).size));
    res.setHeader("Content-Disposition", `inline; filename="${file.filename}"`);
    res.send(readFileSync(abs));
  });

  app.get("/api/file-projects/:slug/files/:fileId/filer", (req: Request, res: Response) => {
    const { slug, file } = resolveFile(deps.store, req);
    if (!file.filerPath) {
      res.status(404).json({ error: "No filer — not an image, or scan still pending." });
      return;
    }
    const abs = deps.store.resolveAbs(slug, file.filerPath);
    if (!existsSync(abs)) {
      res.status(404).json({ error: "Filer missing on disk." });
      return;
    }
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.send(readFileSync(abs, "utf-8"));
  });
}

function parseSlug(req: Request): string {
  const raw = (req.params.slug ?? "").trim();
  const slug = slugify(raw);
  if (!slug) throw new ValidationError("Invalid project slug.");
  return slug;
}

function resolveFile(store: FileProjectStore, req: Request): { slug: string; file: NonNullable<ReturnType<FileProjectStore["read"]>>["files"][number] } {
  const slug = parseSlug(req);
  const project = store.read(slug);
  if (!project) throw new NotFoundError(`Project '${slug}' not found.`);
  const fileId = (req.params.fileId ?? "").trim();
  const file = project.files.find((f) => f.id === fileId);
  if (!file) throw new NotFoundError(`File '${fileId}' not found.`);
  return { slug, file };
}

function extFor(mime: string): string {
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg" || mime === "image/jpg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/heic") return ".heic";
  if (mime === "application/pdf") return ".pdf";
  if (mime === "text/plain") return ".txt";
  if (mime === "text/markdown") return ".md";
  if (mime === "application/json") return ".json";
  return "";
}

// keep `join` import live for any future use without TS unused-import errors.
void join;
