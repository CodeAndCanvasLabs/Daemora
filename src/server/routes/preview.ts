/**
 * /_preview/<slug>/* — live preview of a project's app (Phase 3).
 *
 * Two modes, picked per request:
 *
 *  v2 — LIVE dev server (Bolt/Lovable hot-reload feel). If the project has a
 *       `projects/<slug>/.preview.json` declaring a local `devUrl` (e.g. a Vite
 *       `npm run dev` the agent started in its sandbox), every `/_preview/<slug>/*`
 *       request — and its WebSocket upgrades (HMR) — is reverse-proxied to that
 *       dev server. The dev server must be configured with base `/_preview/<slug>/`
 *       so its asset + HMR URLs resolve under the preview path.
 *
 *  v1 — STATIC built output. Otherwise we serve files from
 *       `<dataDir>/projects/<slug>/{code/dist,code/build,code,.}`, injecting a
 *       <base> tag so relative asset URLs resolve.
 *
 * Read-only + confined to the project folder (path-traversal guarded). devUrl is
 * restricted to loopback to prevent SSRF.
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import { join, resolve, sep } from "node:path";

import type { Express, Request, Response } from "express";

import { createLogger } from "../../util/logger.js";
import { ensureBuild, buildLog } from "../preview/buildManager.js";
import type { ServerDeps } from "../index.js";

const log = createLogger("preview");

const CANDIDATE_SUBDIRS = ["code/dist", "code/build", "code/out", "code", "dist", "build", "out", ""] as const;

/** Guard the slug against path traversal; returns the resolved project root or null. */
function projectRootFor(dataDir: string, slug: string): string | null {
  const projectsRoot = resolve(dataDir, "projects");
  const projectRoot = resolve(projectsRoot, slug);
  if (projectRoot !== join(projectsRoot, slug) || !projectRoot.startsWith(projectsRoot + sep)) return null;
  return projectRoot;
}

/** First dir under the project that has an index.html (the buildable preview root). */
function previewBase(dataDir: string, slug: string): string | null {
  const projectRoot = projectRootFor(dataDir, slug);
  if (!projectRoot) return null;
  for (const sub of CANDIDATE_SUBDIRS) {
    const dir = sub ? join(projectRoot, sub) : projectRoot;
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return null;
}

/**
 * Resolve a project's live dev-server URL from `.preview.json`, if any.
 * Accepts `{ "devUrl": "http://127.0.0.1:5173" }` or `{ "devPort": 5173 }`.
 * Only loopback hosts are allowed (SSRF guard) — the dev server runs inside the
 * tenant's own sandbox. Returns a normalised origin (no trailing slash) or null.
 */
export function resolveDevUrl(dataDir: string, slug: string): string | null {
  const projectRoot = projectRootFor(dataDir, slug);
  if (!projectRoot) return null;
  let cfg: { devUrl?: string; devPort?: number };
  try { cfg = JSON.parse(readFileSync(join(projectRoot, ".preview.json"), "utf8")); } catch { return null; }
  let origin: string | null = null;
  if (typeof cfg.devPort === "number" && cfg.devPort > 0 && cfg.devPort < 65536) {
    origin = `http://127.0.0.1:${cfg.devPort}`;
  } else if (typeof cfg.devUrl === "string") {
    try {
      const u = new URL(cfg.devUrl);
      const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
      if (u.protocol === "http:" && loopback) origin = `http://${u.host}`;
    } catch { /* malformed */ }
  }
  return origin;
}

const SHELL = (body: string) =>
  `<body style="font:14px ui-monospace,monospace;background:#0a0f1a;color:#94a3b8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center">${body}</body>`;

/** Auto-refreshing "compiling…" page shown while the project builds. */
function buildingPage(slug: string): string {
  return `<!doctype html><html><head><meta http-equiv="refresh" content="3"></head>${SHELL(
    `<div><div style="width:28px;height:28px;border:3px solid #1e293b;border-top-color:#00d9ff;border-radius:50%;margin:0 auto 16px;animation:s 0.8s linear infinite"></div>` +
    `Building <b style="color:#e2e8f0">${slug}</b>…<br><br><span style="font-size:12px;color:#64748b">compiling the app — this updates automatically when it's ready</span>` +
    `<style>@keyframes s{to{transform:rotate(360deg)}}</style></div>`,
  )}</html>`;
}

/** Build-failed page with the log tail (so the user/agent can see why). */
function failedPage(slug: string, logTail: string): string {
  const esc = logTail.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] ?? c));
  return `<!doctype html>${SHELL(
    `<div style="max-width:760px"><div style="color:#f87171;font-size:15px;margin-bottom:10px">Build failed for ${slug}</div>` +
    `<pre style="text-align:left;background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:12px;color:#cbd5e1;font-size:11px;max-height:60vh;overflow:auto;white-space:pre-wrap">${esc || "(no output)"}</pre>` +
    `<div style="font-size:12px;color:#64748b;margin-top:10px">Ask the agent to fix the build, then reopen Preview.</div></div>`,
  )}</html>`;
}

export function mountPreviewRoutes(app: Express, deps: ServerDeps): void {
  // Handle ALL methods so a live dev server (which may serve POST/api routes)
  // works; static mode only answers GET. group 1 = slug, group 2 = "/sub/path".
  app.all(/^\/_preview\/([^/?]+)(\/[^?]*)?$/, (req: Request, res: Response) => {
    const slug = decodeURIComponent((req.params as unknown as string[])[0] ?? "");

    // ── v2: live dev-server proxy ──
    const devUrl = resolveDevUrl(deps.cfg.env.dataDir, slug);
    if (devUrl) { proxyToDevServer(devUrl, req, res); return; }

    // ── v1: static built output (GET only) ──
    if (req.method !== "GET") { res.status(405).send("method not allowed (no live dev server for this project)"); return; }
    const rawSub = (req.params as unknown as string[])[1];
    const sub = rawSub ? decodeURIComponent(rawSub) : "/";

    const base = previewBase(deps.cfg.env.dataDir, slug);
    if (!base) {
      // No built output yet — auto-build on demand (coding projects with source).
      // Only kick off on the index request; assets 404 until the build lands.
      const projectRoot = projectRootFor(deps.cfg.env.dataDir, slug);
      const isIndex = sub === "/" || sub === "";
      if (projectRoot && isIndex) {
        const status = ensureBuild(slug, projectRoot, deps.guard);
        if (status === "building") { res.status(200).type("html").send(buildingPage(slug)); return; }
        if (status === "failed") { res.status(200).type("html").send(failedPage(slug, buildLog(slug))); return; }
      }
      res.status(404).type("html").send(
        `<body style="font:14px system-ui;background:#0a0f1a;color:#94a3b8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">` +
        `<div>No preview yet.<br><br>The agent builds a runnable app under <code>projects/${slug}/code/</code> (compiled to <code>dist/</code>), then it shows here.</div></body>`,
      );
      return;
    }

    const rel = sub === "/" || sub === "" ? "/index.html" : sub;
    let target = resolve(base, "." + rel);
    if (target !== base && !target.startsWith(base + sep)) { res.status(403).send("forbidden"); return; }
    if (!existsSync(target) || !statSync(target).isFile()) {
      target = join(base, "index.html"); // SPA-style fallback for client-routed apps
      if (!existsSync(target)) { res.status(404).send("not found"); return; }
    }

    if (target.endsWith("index.html")) {
      try {
        const html = readFileSync(target, "utf-8");
        const baseTag = `<base href="/_preview/${encodeURIComponent(slug)}/">`;
        const injected = /<head[^>]*>/i.test(html)
          ? html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`)
          : `${baseTag}${html}`;
        res.type("html").send(injected);
        return;
      } catch { /* fall through to sendFile */ }
    }
    res.sendFile(target);
  });
}

/** Reverse-proxy a single HTTP request to the project's dev server (verbatim path). */
function proxyToDevServer(devUrl: string, req: Request, res: Response): void {
  const target = new URL(req.originalUrl, devUrl);
  const headers = { ...req.headers, host: target.host };
  const upstream = http.request(
    target,
    { method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers as Record<string, string | string[]>);
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.status(502).type("html").send(
        `<body style="font:14px system-ui;background:#0a0f1a;color:#94a3b8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">` +
        `<div>Dev server not reachable.<br><br>Start it in the project (e.g. <code>npm run dev</code>) — it's declared in <code>.preview.json</code> but isn't responding.<br><small>${(err as Error).message}</small></div></body>`,
      );
    }
  });
  req.pipe(upstream);
}

/**
 * Attach a WebSocket-upgrade proxy to the tenant's HTTP server so dev-server HMR
 * (Vite/webpack live reload) works through `/_preview/<slug>/`. Call once after
 * `server.listen()`. Non-preview upgrades (e.g. the voice socket) are left alone.
 */
export function attachPreviewUpgrade(server: http.Server, dataDir: string): void {
  server.on("upgrade", (req, socket: Socket, head) => {
    const url = req.url ?? "";
    const m = /^\/_preview\/([^/?]+)(?:\/|$)/.exec(url);
    if (!m) return; // not a preview upgrade — leave it for other handlers (voice, etc.)
    const slug = decodeURIComponent(m[1] ?? "");
    const devUrl = resolveDevUrl(dataDir, slug);
    if (!devUrl) { socket.destroy(); return; }

    const target = new URL(url, devUrl);
    const proxyReq = http.request(target, {
      method: req.method,
      headers: { ...req.headers, host: target.host },
    });
    proxyReq.on("upgrade", (proxyRes, proxySocket: Socket, proxyHead) => {
      const lines = [`HTTP/1.1 101 ${proxyRes.statusMessage ?? "Switching Protocols"}`];
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (Array.isArray(v)) for (const vv of v) lines.push(`${k}: ${vv}`);
        else if (v != null) lines.push(`${k}: ${v}`);
      }
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      if (proxyHead?.length) socket.write(proxyHead);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
      proxySocket.on("error", () => socket.destroy());
      socket.on("error", () => proxySocket.destroy());
    });
    proxyReq.on("error", () => { socket.destroy(); });
    if (head?.length) proxyReq.write(head);
    proxyReq.end();
    log.info({ slug }, "proxying preview HMR websocket to dev server");
  });
}
