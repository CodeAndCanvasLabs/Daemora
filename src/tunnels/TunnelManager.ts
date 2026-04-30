/**
 * TunnelManager — resolves a public URL for inbound webhooks.
 *
 * Resolution order (first match wins):
 *   1. `PUBLIC_URL` setting      — user controls their own reverse proxy
 *   2. cloudflared named tunnel  — user has `~/.cloudflared/<id>.json` + `config.yml`
 *   3. cloudflared quick tunnel  — zero-config, URL rotates per run
 *   4. Tailscale funnel           — user configured `tailscale serve --funnel`
 *   5. fallback → localhost       — with a loud warning in logs
 *
 * Why cloudflared is the default: free, no signup for quick tunnels,
 * real TLS, no browser interstitial (unlike ngrok's free tier), URL
 * stability depends on the tunnel process staying alive. Named tunnels
 * give a stable URL forever.
 *
 * We spawn the tunnel as a child process and parse its stdout for the
 * URL. On shutdown, we SIGTERM the child.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createLogger } from "../util/logger.js";

const log = createLogger("tunnel");

export type TunnelKind = "configured" | "cloudflared-named" | "cloudflared-quick" | "tailscale" | "none";

export interface TunnelResult {
  readonly url: string;
  readonly kind: TunnelKind;
}

export interface TunnelOpts {
  readonly port: number;
  /** Honours user-configured `PUBLIC_URL` before spawning anything. */
  readonly publicUrl?: string;
  /**
   * Control which auto-provisioning providers to try. Useful for tests
   * or users who want to explicitly opt out (e.g. airgapped machines).
   */
  readonly providers?: readonly TunnelKind[];
}

const DEFAULT_PROVIDERS: readonly TunnelKind[] = [
  "cloudflared-named",
  "cloudflared-quick",
  "tailscale",
];

export class TunnelManager {
  private child: ChildProcess | null = null;
  private active: TunnelResult = { url: "", kind: "none" };

  /**
   * Start (or resolve) a tunnel. Returns the public URL if one was
   * obtained, or an empty string + kind="none" if nothing worked.
   *
   * Idempotent: repeated calls reuse the existing tunnel.
   */
  async start(opts: TunnelOpts): Promise<TunnelResult> {
    if (this.active.kind !== "none") return this.active;

    if (opts.publicUrl && opts.publicUrl.length > 0) {
      this.active = { url: opts.publicUrl.replace(/\/$/, ""), kind: "configured" };
      log.info({ url: this.active.url }, "using configured PUBLIC_URL (no tunnel spawned)");
      return this.active;
    }

    const providers = opts.providers ?? DEFAULT_PROVIDERS;

    for (const p of providers) {
      try {
        const result = await this.tryProvider(p, opts.port);
        if (result) {
          this.active = result;
          log.info({ kind: result.kind, url: result.url }, "tunnel up");
          return result;
        }
      } catch (e) {
        log.warn({ provider: p, err: (e as Error).message }, "tunnel provider failed");
      }
    }

    log.warn("no tunnel available — webhooks from external providers will fail. Install `cloudflared` or set PUBLIC_URL.");
    return { url: "", kind: "none" };
  }

  /** Stop the spawned tunnel child (no-op if we didn't spawn one). */
  stop(): void {
    if (this.child && !this.child.killed) {
      try { this.child.kill("SIGTERM"); } catch { /* ignore */ }
    }
    this.child = null;
    this.active = { url: "", kind: "none" };
  }

  current(): TunnelResult {
    return this.active;
  }

  // ── Providers ──────────────────────────────────────────────────────────

  private async tryProvider(kind: TunnelKind, port: number): Promise<TunnelResult | null> {
    if (kind === "cloudflared-named") return this.tryCloudflaredNamed(port);
    if (kind === "cloudflared-quick") return this.tryCloudflaredQuick(port);
    if (kind === "tailscale") return this.tryTailscale();
    return null;
  }

  private async tryCloudflaredNamed(_port: number): Promise<TunnelResult | null> {
    // A named tunnel is identified by `config.yml` under ~/.cloudflared/.
    // If absent, we can't spin one up automatically; quick-tunnel is the fallback.
    if (!isCmdAvailable("cloudflared")) return null;
    const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
    if (!home) return null;
    const configPath = `${home}/.cloudflared/config.yml`;
    const { existsSync, readFileSync } = await import("node:fs");
    if (!existsSync(configPath)) return null;

    // Read `hostname:` from the config — that's the stable URL.
    const raw = readFileSync(configPath, "utf-8");
    const hostnameMatch = /^\s*hostname:\s*["']?([^\s"']+)/m.exec(raw);
    if (!hostnameMatch || !hostnameMatch[1]) return null;
    const hostname = hostnameMatch[1].trim();

    // Start the tunnel detached so we keep ownership of the child.
    const proc = spawn("cloudflared", ["tunnel", "run"], { stdio: "ignore" });
    proc.on("error", (err) => log.warn({ err: err.message }, "cloudflared named crashed"));
    this.child = proc;
    return { url: `https://${hostname}`, kind: "cloudflared-named" };
  }

  private tryCloudflaredQuick(port: number): Promise<TunnelResult | null> {
    return new Promise((resolve) => {
      if (!isCmdAvailable("cloudflared")) return resolve(null);
      const proc = spawn("cloudflared", [
        "tunnel",
        "--url", `http://localhost:${port}`,
        "--no-autoupdate",
      ], { stdio: ["ignore", "pipe", "pipe"] });

      let settled = false;
      const settle = (result: TunnelResult | null) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      // Quick-tunnel URLs match `https://<random>.trycloudflare.com`.
      const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
      const onData = (buf: Buffer) => {
        const text = buf.toString("utf-8");
        const m = URL_RE.exec(text);
        if (m) settle({ url: m[0], kind: "cloudflared-quick" });
      };
      proc.stderr.on("data", onData);
      proc.stdout.on("data", onData);
      proc.on("error", (err) => {
        log.warn({ err: err.message }, "cloudflared-quick spawn failed");
        settle(null);
      });
      proc.on("exit", (code) => {
        if (!settled) {
          log.warn({ code }, "cloudflared-quick exited before URL detected");
          settle(null);
        }
      });
      this.child = proc;

      // Give it up to 20s to announce the URL. Cloudflare usually does in < 5s.
      setTimeout(() => {
        if (!settled) {
          log.warn("cloudflared-quick timeout (20s) — no URL detected");
          settle(null);
        }
      }, 20_000).unref();
    });
  }

  private async tryTailscale(): Promise<TunnelResult | null> {
    if (!isCmdAvailable("tailscale")) return null;
    // `tailscale status --json` tells us whether funnel is configured
    // for this machine. We don't try to configure funnel automatically —
    // user must `tailscale serve --bg https:443 http://localhost:<port>`
    // + `tailscale funnel 443 on` first. If both are set, we just
    // surface the resulting `<host>.ts.net` URL.
    const res = spawnSync("tailscale", ["status", "--json"], { encoding: "utf-8" });
    if (res.status !== 0) return null;
    try {
      const parsed = JSON.parse(res.stdout) as {
        Self?: { DNSName?: string };
        CurrentTailnet?: { MagicDNSSuffix?: string };
      };
      const dns = parsed.Self?.DNSName?.replace(/\.$/, "");
      if (!dns) return null;
      return { url: `https://${dns}`, kind: "tailscale" };
    } catch {
      return null;
    }
  }
}

function isCmdAvailable(bin: string): boolean {
  const which = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(which, [bin], { stdio: "ignore" });
  return res.status === 0;
}
