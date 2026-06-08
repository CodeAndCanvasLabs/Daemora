/**
 * Single-ingress gateway HTTP server.
 *
 * Routes:
 *   - the gateway's OWN routes (/api/auth, /signup, /billing, /agents, /health)
 *     → the Hono app
 *   - everything else → the authenticated user's tenant (proxy). The per-tenant
 *     daemora also serves /api/*, so we match the gateway's SPECIFIC prefixes,
 *     never all of /api/.
 *
 * SECURITY: tenant traffic is routed strictly by `resolveAuthedTenant` (the
 * authenticated user's own tenant) — no client-supplied slug. A short-lived
 * HMAC `X-Daemora-User` identity header is injected so the tenant trusts only
 * the gateway (verified tenant-side when INTERNAL_SIGNING_SECRET is set).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import { getRequestListener } from "@hono/node-server";

import { proxyHttp, proxyUpgrade } from "../../../../src/multitenant/controlPlane.js";
import { signIdentity } from "../../../../src/multitenant/identityToken.js";
import type { TenantManager } from "../../../../src/multitenant/TenantManager.js";
import { createLogger } from "../../../../src/util/logger.js";
import { resolveAuthedTenant, type ResolveDeps } from "./resolve.js";

const log = createLogger("gateway.server");

// "/api/me" is the gateway's OWN config endpoint (central Postgres). Every other
// "/api/*" path proxies to the tenant, so this prefix must be matched here.
const APP_PREFIXES = ["/api/auth", "/api/me", "/signup", "/billing", "/agents", "/internal", "/health"] as const;

function isAppRoute(rawUrl: string): boolean {
  const path = rawUrl.split("?")[0] ?? "/";
  return APP_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

function nodeHeaders(req: IncomingMessage): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const vv of v) h.append(k, vv);
    else h.set(k, v);
  }
  return h;
}

export interface GatewayServerDeps extends ResolveDeps {
  readonly manager: TenantManager;
  readonly honoFetch: (request: Request) => Response | Promise<Response>;
  readonly signingSecret?: string;
}

/** Build (but don't listen on) the gateway server. Caller does `.listen(port)`. */
export function createGatewayServer(deps: GatewayServerDeps): ReturnType<typeof createServer> {
  const honoListener = getRequestListener(deps.honoFetch);

  const server = createServer((req, res) => {
    if (isAppRoute(req.url ?? "/")) {
      honoListener(req, res);
      return;
    }
    handleTenant(req, res, deps).catch((err) => {
      log.error({ err: (err as Error).message }, "tenant proxy error");
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    });
  });

  server.on("upgrade", (req, socket, head) => {
    handleUpgrade(req, socket as Socket, head, deps).catch(() => {
      try { (socket as Socket).destroy(); } catch { /* */ }
    });
  });

  return server;
}

async function handleTenant(req: IncomingMessage, res: ServerResponse, deps: GatewayServerDeps): Promise<void> {
  const resolved = await resolveAuthedTenant(deps, nodeHeaders(req));
  if (!resolved) { sendJson(res, 401, { error: "unauthorized" }); return; }
  if (resolved.status === "suspended") { sendJson(res, 402, { error: "subscription_required" }); return; }
  if (resolved.status === "archived") { sendJson(res, 410, { error: "tenant_archived" }); return; }

  const tenant = deps.manager.get(resolved.slug);
  if (!tenant) { sendJson(res, 404, { error: "unknown_tenant" }); return; }
  // start() is idempotent and self-healing: it returns the live child fast, or
  // adopts a healthy orphan, or respawns a dead one. Call it every request and
  // use its returned upstream — never a cached URL, which can point at a child
  // that has since exited (stale-map → ECONNREFUSED).
  let upstream: string;
  try {
    upstream = (await deps.manager.start(resolved.slug)).upstreamUrl;
  } catch (err) {
    log.error({ slug: resolved.slug, err: (err as Error).message }, "tenant wake failed");
    sendJson(res, 503, { error: "tenant_wake_failed" });
    return;
  }
  if (!upstream) { sendJson(res, 503, { error: "tenant_unreachable" }); return; }
  if (deps.signingSecret) req.headers["x-daemora-user"] = signIdentity(deps.signingSecret, resolved.userId, resolved.slug);
  await proxyHttp(req, res, upstream);
}

async function handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer, deps: GatewayServerDeps): Promise<void> {
  const resolved = await resolveAuthedTenant(deps, nodeHeaders(req));
  if (!resolved || resolved.status === "suspended" || resolved.status === "archived") {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return;
  }
  const tenant = deps.manager.get(resolved.slug);
  if (!tenant) { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); return; }
  let upstream: string;
  try { upstream = (await deps.manager.start(resolved.slug)).upstreamUrl; }
  catch { socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n"); socket.destroy(); return; }
  if (!upstream) { socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n"); socket.destroy(); return; }
  if (deps.signingSecret) req.headers["x-daemora-user"] = signIdentity(deps.signingSecret, resolved.userId, resolved.slug);
  proxyUpgrade(req, socket, head, upstream);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
