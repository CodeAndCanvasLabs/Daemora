/**
 * Control plane — the single ingress for multi-tenant daemora.
 *
 *   :8080  → control plane (this file)
 *   :8101  → tenant alice's daemora
 *   :8102  → tenant bob's daemora
 *   ...
 *
 * Routes:
 *   /admin/*   — admin API (auth: CONTROL_PLANE_ADMIN_TOKEN bearer)
 *   /health    — control plane's own health
 *   anything else → resolve tenant → proxy
 *
 * Tenant resolution (see resolveTenant for the security model):
 *   - production: Host subdomain only (e.g. `alice.daemora.app`)
 *   - dev/test: also `X-Tenant-Slug` header, `?slug=` query, tenant cookie
 *     (all UNAUTHENTICATED hints — refused in production)
 *
 * Wakes a sleeping tenant on first inbound request. Returns 402 for
 * suspended tenants, 410 for archived.
 */

import { IncomingMessage, ServerResponse, createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import { Socket } from "node:net";

import { createLogger } from "../util/logger.js";
import type { TenantManager } from "./TenantManager.js";

const log = createLogger("multitenant.controlPlane");

export interface ControlPlaneOpts {
  readonly port: number;                 // typically 8080
  readonly manager: TenantManager;
  readonly hostSuffix?: string;          // e.g. ".daemora.app" — for subdomain extraction
  readonly adminToken?: string;          // bearer required for /admin/*; if empty, /admin is disabled
}

export interface ControlPlane {
  readonly server: Server;
  close(): Promise<void>;
}

export function startControlPlane(opts: ControlPlaneOpts): ControlPlane {
  const { port, manager, hostSuffix, adminToken } = opts;

  const handlerOpts: { hostSuffix?: string; adminToken?: string } = {};
  if (hostSuffix) handlerOpts.hostSuffix = hostSuffix;
  if (adminToken) handlerOpts.adminToken = adminToken;
  const upgradeOpts: { hostSuffix?: string } = {};
  if (hostSuffix) upgradeOpts.hostSuffix = hostSuffix;

  const server = createServer((req, res) => {
    handleRequest(req, res, manager, handlerOpts).catch((err) => {
      log.error({ err: (err as Error).message }, "request handler error");
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "internal error" }));
      }
    });
  });

  // WebSocket upgrade — same routing logic, but pipe sockets.
  server.on("upgrade", (req, socket, head) => {
    handleUpgrade(req, socket as Socket, head, manager, upgradeOpts).catch((err) => {
      log.error({ err: (err as Error).message }, "upgrade handler error");
      socket.destroy();
    });
  });

  server.listen(port, () => {
    log.info({ port, hostSuffix }, "control plane listening");
  });

  return {
    server,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ── request routing ───────────────────────────────────────────────

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  manager: TenantManager,
  opts: { hostSuffix?: string; adminToken?: string },
): Promise<void> {
  const url = req.url ?? "/";

  // Health is unauthenticated.
  if (url === "/health" || url === "/healthz") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, running: manager.listRunning().length }));
    return;
  }

  // Admin API.
  if (url.startsWith("/admin/")) {
    return adminRoute(req, res, manager, opts.adminToken);
  }

  // Resolve tenant.
  const slug = resolveTenant(req, opts.hostSuffix);
  if (!slug) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "tenant could not be resolved (production: use the Host subdomain)" }));
    return;
  }

  const tenant = manager.get(slug);
  if (!tenant) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: `unknown tenant: ${slug}` }));
    return;
  }

  if (tenant.status === "suspended") {
    res.statusCode = 402;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      error: "subscription_required",
      detail: tenant.suspendReason ?? "Tenant suspended",
    }));
    return;
  }

  if (tenant.status === "archived") {
    res.statusCode = 410;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "tenant_archived" }));
    return;
  }

  // Wake if sleeping.
  if (tenant.status !== "running") {
    try {
      await manager.start(slug);
    } catch (err) {
      log.error({ slug, err: (err as Error).message }, "wake failed");
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "tenant_wake_failed", detail: (err as Error).message }));
      return;
    }
  }

  // Proxy HTTP. If the slug came from `?slug=`, also pin it in a cookie
  // so the SPA's subsequent asset/XHR requests resolve without the param.
  const upstreamUrl = manager.getUpstreamUrl(slug) ?? `http://127.0.0.1:${tenant.port}`;
  const extraCookie = slugCameFromQuery(req)
    ? `${TENANT_COOKIE_NAME}=${encodeURIComponent(slug)}; Path=/; SameSite=Lax; Max-Age=86400`
    : undefined;
  await proxyHttp(req, res, upstreamUrl, extraCookie ? { setCookie: extraCookie } : {});
}

// ── upgrade routing (WebSocket) ───────────────────────────────────

async function handleUpgrade(
  req: IncomingMessage,
  clientSocket: Socket,
  head: Buffer,
  manager: TenantManager,
  opts: { hostSuffix?: string },
): Promise<void> {
  const slug = resolveTenant(req, opts.hostSuffix);
  if (!slug) {
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.destroy();
    return;
  }
  const tenant = manager.get(slug);
  if (!tenant || tenant.status === "suspended" || tenant.status === "archived") {
    clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    clientSocket.destroy();
    return;
  }
  if (tenant.status !== "running") {
    try {
      await manager.start(slug);
    } catch {
      clientSocket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      clientSocket.destroy();
      return;
    }
  }
  const upstreamUrl = manager.getUpstreamUrl(slug) ?? `http://127.0.0.1:${tenant.port}`;
  proxyUpgrade(req, clientSocket, head, upstreamUrl);
}

// ── tenant resolution ────────────────────────────────────────────

export const TENANT_COOKIE_NAME = "daemora-tenant";

/**
 * Resolve which tenant a request targets.
 *
 * SECURITY: in production the ONLY honored method is the Host subdomain.
 * Every other method here — `X-Tenant-Slug` header, `?slug=` query, tenant
 * cookie — is an UNAUTHENTICATED routing hint that any caller can set to
 * reach any tenant, so it is gated to dev/test routing only and refused in
 * production. The previous forgeable path (decode an *unverified* JWT
 * `tenant` claim) has been removed outright.
 *
 * KNOWN GAP: even subdomain routing does not yet prove the *caller* owns
 * the tenant. Per-caller authorization (authenticated session → that user's
 * own tenant) lands with the authenticating gateway (task #27); until then
 * production must keep the tenant farm behind the network boundary and the
 * per-tenant daemoras must not be exposed directly.
 */
export function resolveTenant(req: IncomingMessage, hostSuffix?: string): string | undefined {
  // Unauthenticated dev/test routing hints are honored ONLY outside
  // production (or when explicitly opted in via DAEMORA_DEV_ROUTING=1).
  const devRouting = process.env["DAEMORA_DEV_ROUTING"] === "1"
    || process.env["NODE_ENV"] !== "production";

  // 1. Explicit header (dev/test, server-to-server). Dev-gated.
  if (devRouting) {
    const header = req.headers["x-tenant-slug"];
    if (typeof header === "string" && header.length > 0) {
      return sanitiseSlug(header);
    }
  }

  // 2. Subdomain of Host (production routing — the only method honored in prod).
  const host = (req.headers.host ?? "").split(":")[0]?.toLowerCase();
  if (host && hostSuffix && host.endsWith(hostSuffix)) {
    const slug = host.slice(0, host.length - hostSuffix.length);
    if (slug.length > 0) return sanitiseSlug(slug);
  }

  // The remaining hints are dev-only and unauthenticated.
  if (!devRouting) return undefined;

  // 3. Query-string slug (dev kickoff — first hit from a browser tab).
  //    A successful resolution here causes a Set-Cookie so sub-resources
  //    (assets, XHR) on the same origin re-resolve via cookie below.
  try {
    const u = new URL(req.url ?? "/", "http://x.local");
    const q = u.searchParams.get("slug");
    if (q) return sanitiseSlug(q);
  } catch { /* malformed URL — skip */ }

  // 4. Cookie (dev follow-up — set on the response when query resolved).
  const cookieHeader = req.headers["cookie"];
  if (typeof cookieHeader === "string") {
    const match = new RegExp(`(?:^|;\\s*)${TENANT_COOKIE_NAME}=([^;]+)`).exec(cookieHeader);
    if (match?.[1]) return sanitiseSlug(decodeURIComponent(match[1]));
  }

  return undefined;
}

/** Was this request's slug supplied via the `?slug=` query? Used to decide whether to issue Set-Cookie. */
export function slugCameFromQuery(req: IncomingMessage): boolean {
  try {
    const u = new URL(req.url ?? "/", "http://x.local");
    return u.searchParams.has("slug");
  } catch {
    return false;
  }
}

function sanitiseSlug(s: string): string | undefined {
  const trimmed = s.toLowerCase();
  if (/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(trimmed) && trimmed.length <= 63) return trimmed;
  return undefined;
}

// ── proxy primitives ─────────────────────────────────────────────
// Exported so the single-ingress gateway (apps/api) can reuse the exact
// same raw-http + WebSocket proxy after it authenticates the request.

export function proxyHttp(
  req: IncomingMessage,
  res: ServerResponse,
  upstreamUrl: string,
  opts: { setCookie?: string } = {},
): Promise<void> {
  return new Promise((resolve) => {
    const u = new URL(upstreamUrl);
    const upstream = httpRequest(
      {
        host: u.hostname,
        port: u.port ? Number(u.port) : 80,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: u.host },
      },
      (upstreamRes) => {
        const headers = { ...upstreamRes.headers };
        if (opts.setCookie) {
          const existing = headers["set-cookie"];
          headers["set-cookie"] = existing
            ? [...(Array.isArray(existing) ? existing : [existing]), opts.setCookie]
            : [opts.setCookie];
        }
        res.writeHead(upstreamRes.statusCode ?? 502, headers);
        upstreamRes.pipe(res);
        upstreamRes.on("end", () => resolve());
      },
    );

    upstream.on("error", (err) => {
      log.warn({ err: err.message, upstreamUrl }, "upstream connection failed");
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "tenant_unreachable" }));
      } else {
        res.end();
      }
      resolve();
    });

    req.pipe(upstream);
  });
}

export function proxyUpgrade(req: IncomingMessage, clientSocket: Socket, head: Buffer, upstreamUrl: string): void {
  const u = new URL(upstreamUrl);
  const upstream = httpRequest({
    host: u.hostname,
    port: u.port ? Number(u.port) : 80,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: u.host },
  });

  upstream.on("upgrade", (upstreamRes, upstreamSocket) => {
    // Forward the handshake response and bridge sockets both ways.
    const statusLine = `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}`;
    const headerLines = Object.entries(upstreamRes.headers)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => Array.isArray(v) ? v.map((vv) => `${k}: ${vv}`).join("\r\n") : `${k}: ${v}`)
      .join("\r\n");
    clientSocket.write(`${statusLine}\r\n${headerLines}\r\n\r\n`);

    if (head && head.length > 0) clientSocket.write(head);
    upstreamSocket.pipe(clientSocket).pipe(upstreamSocket);

    const onClose = (): void => {
      try { upstreamSocket.destroy(); } catch { /* */ }
      try { clientSocket.destroy(); } catch { /* */ }
    };
    upstreamSocket.on("close", onClose);
    clientSocket.on("close", onClose);
    upstreamSocket.on("error", onClose);
    clientSocket.on("error", onClose);
  });

  upstream.on("error", (err) => {
    log.warn({ err: err.message, upstreamUrl }, "upgrade upstream failed");
    try { clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch { /* */ }
    clientSocket.destroy();
  });

  upstream.end();
}

// ── admin API ────────────────────────────────────────────────────

async function adminRoute(
  req: IncomingMessage,
  res: ServerResponse,
  manager: TenantManager,
  adminToken: string | undefined,
): Promise<void> {
  if (!adminToken) {
    res.statusCode = 503;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "admin_disabled", detail: "set CONTROL_PLANE_ADMIN_TOKEN to enable" }));
    return;
  }
  const auth = req.headers["authorization"];
  const token = typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";
  if (!constantTimeEqual(token, adminToken)) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const url = req.url ?? "";
  const json = (status: number, body: unknown): void => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };

  // GET /admin/tenants
  if (req.method === "GET" && url === "/admin/tenants") {
    return json(200, { tenants: manager.list() });
  }

  // GET /admin/tenants/:slug
  if (req.method === "GET" && /^\/admin\/tenants\/[^/]+$/.test(url)) {
    const slug = url.split("/")[3]!;
    const t = manager.get(slug);
    if (!t) return json(404, { error: "not_found" });
    return json(200, manager.show(slug));
  }

  // POST /admin/tenants  { email, plan?, slug? }
  if (req.method === "POST" && url === "/admin/tenants") {
    const body = await readJson(req);
    try {
      const tenant = await manager.create(body as never);
      return json(201, tenant);
    } catch (e) {
      return json(400, { error: (e as Error).message });
    }
  }

  // POST /admin/tenants/:slug/start
  if (req.method === "POST" && /^\/admin\/tenants\/[^/]+\/start$/.test(url)) {
    const slug = url.split("/")[3]!;
    try {
      const { id, port } = await manager.start(slug);
      return json(200, { id, port });
    } catch (e) {
      return json(400, { error: (e as Error).message });
    }
  }

  // POST /admin/tenants/:slug/stop
  if (req.method === "POST" && /^\/admin\/tenants\/[^/]+\/stop$/.test(url)) {
    const slug = url.split("/")[3]!;
    await manager.stop(slug);
    return json(200, { ok: true });
  }

  // POST /admin/tenants/:slug/suspend  { reason }
  if (req.method === "POST" && /^\/admin\/tenants\/[^/]+\/suspend$/.test(url)) {
    const slug = url.split("/")[3]!;
    const body = await readJson(req).catch(() => ({})) as { reason?: string };
    await manager.suspend(slug, body.reason ?? "");
    return json(200, { ok: true });
  }

  json(404, { error: "not_found" });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
