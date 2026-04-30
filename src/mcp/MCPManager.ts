/**
 * MCPManager — connects to MCP servers and exposes their tools to
 * the agent. Handles stdio + HTTP transports, tool discovery, and
 * invocation. Tools are registered with the naming convention
 * `mcp__{serverName}__{toolName}`.
 *
 * Runtime connection lifecycle:
 *   1. loadAll() — read config, connect enabled servers
 *   2. Agent calls tool → MCPManager dispatches to the right client
 *   3. Server added/removed/toggled via API → connect/disconnect
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { createLogger } from "../util/logger.js";
import type { SecretVault } from "../config/SecretVault.js";
import { argFieldsFor, descriptionFor, requiredEnvFor } from "./defaults.js";
import type { MCPStore, MCPServerEntry } from "./MCPStore.js";

const log = createLogger("mcp.manager");

export interface MCPArgFieldStatus {
  readonly index: number;
  readonly label: string;
  readonly kind: "path" | "text";
  readonly hint?: string;
  /** Current value from mcp.json at that positional index. */
  readonly value: string;
}

export interface MCPServerStatus {
  readonly name: string;
  readonly status: string;
  readonly transport: string;
  readonly tools: readonly { name: string; description: string }[];
  readonly enabled: boolean;
  readonly connected: boolean;
  readonly configured: boolean;
  readonly requiredEnv: readonly string[];
  readonly missingEnv: readonly string[];
  readonly argFields: readonly MCPArgFieldStatus[];
  readonly description?: string;
  error?: string;
}

export interface MCPTool {
  readonly serverName: string;
  readonly name: string;
  readonly fullName: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

interface ConnectedServer {
  config: MCPServerEntry;
  process?: ChildProcess;
  tools: MCPTool[];
  status: "connected" | "error" | "disconnected";
  error?: string;
}

export class MCPManager extends EventEmitter {
  private readonly servers = new Map<string, ConnectedServer>();

  /**
   * `vault` is optional because the store can be used in tests
   * without a full ConfigManager. When provided, `connect()` resolves
   * env / header values from the vault for any key that's either
   * empty or a `${VAR}` placeholder — so sensitive credentials live
   * encrypted in SQLite rather than plaintext in `mcp.json`.
   *
   * `integrationToken` is a lightweight lookup the MCPIntegrationBridge
   * wires in after IntegrationManager exists. It lets `mcp.json`
   * reference an OAuth token through the `${INTEGRATION:<id>}`
   * placeholder without persisting the token to disk — the bridge
   * keeps the cache warm on connect / refresh events.
   */
  constructor(
    private readonly store: MCPStore,
    private readonly vault?: SecretVault,
    private integrationToken?: (integration: string) => string | undefined,
  ) {
    super();
  }

  /** Install / replace the integration-token lookup. Called by the bridge. */
  setIntegrationTokenProvider(fn: (integration: string) => string | undefined): void {
    this.integrationToken = fn;
  }

  /** Connect all enabled servers from config. */
  async loadAll(): Promise<void> {
    const configs = this.store.list();
    const enabled = configs.filter((c) => c.enabled !== false);
    log.info({ total: configs.length, enabled: enabled.length }, "loading MCP servers");

    await Promise.all(enabled.map((cfg) => this.connect(cfg)));
  }

  /** Connect a single server by config. */
  async connect(config: MCPServerEntry): Promise<void> {
    const { name } = config;
    if (this.servers.has(name)) {
      await this.disconnect(name);
    }

    const entry: ConnectedServer = { config, tools: [], status: "disconnected" };
    this.servers.set(name, entry);

    try {
      const resolvedEnv = this.resolveEnv(config.env);
      const resolvedHeaders = this.resolveEnv(config.headers);

      if (config.command) {
        // Stdio transport — spawn subprocess.
        const child = spawn(config.command, config.args ?? [], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, ...resolvedEnv },
        });
        entry.process = child;

        // Capture stderr so first-run failures (missing package, bad
        // env, etc.) show up in our logs instead of the agent seeing
        // a mysterious "tools/list timeout".
        const stderrBuf: string[] = [];
        child.stderr?.on("data", (chunk: Buffer) => {
          const s = chunk.toString("utf-8");
          stderrBuf.push(s);
          // Keep only the last ~4 KB so a chatty server doesn't grow
          // unbounded memory.
          const joined = stderrBuf.join("");
          if (joined.length > 4096) {
            stderrBuf.length = 0;
            stderrBuf.push(joined.slice(-4096));
          }
        });
        child.on("error", (err) => {
          log.error({ name, err: err.message }, "MCP stdio spawn error");
        });

        // MCP over stdio: JSON-RPC messages over stdin/stdout.
        // First-run `npx -y <pkg>` can take a while to download the
        // server binary on a cold cache. We give initialize a generous
        // 60s window; subsequent calls reuse the cached install.
        try {
          const tools = await this.discoverToolsStdio(child, name);
          entry.tools = tools;
          entry.status = "connected";
        } catch (discoverErr) {
          const tail = stderrBuf.join("").slice(-800).trim();
          const detail = tail ? ` stderr: ${tail}` : "";
          throw new Error(`${(discoverErr as Error).message}${detail}`);
        }

        child.on("exit", (code) => {
          log.warn({ name, code }, "MCP server process exited");
          entry.status = "disconnected";
        });
      } else if (config.url) {
        // HTTP transport — discover tools via HTTP
        const tools = await this.discoverToolsHttp(config.url, name, resolvedHeaders);
        entry.tools = tools;
        entry.status = "connected";
      } else {
        throw new Error("MCP server needs either `command` (stdio) or `url` (http)");
      }

      log.info({ name, tools: entry.tools.length, transport: config.command ? "stdio" : "http" }, "MCP server connected");
      this.emit("connected", name);
    } catch (e) {
      entry.status = "error";
      entry.error = (e as Error).message;
      log.error({ name, err: entry.error }, "MCP server connection failed");
    }
  }

  /** Disconnect a server. */
  async disconnect(name: string): Promise<void> {
    const entry = this.servers.get(name);
    if (!entry) return;
    if (entry.process && !entry.process.killed) {
      entry.process.kill("SIGTERM");
      setTimeout(() => entry.process?.kill("SIGKILL"), 3000).unref();
    }
    this.servers.delete(name);
    this.emit("disconnected", name);
  }

  /**
   * Rich status for the API + UI. Each entry includes:
   *   • `connected` — actually up and answering.
   *   • `configured` — all `requiredEnv` keys (from defaults.ts) have
   *     non-empty values. When false, the UI can offer a "fill in
   *     missing config" dialog before activating.
   *   • `missingEnv` — exact names of empty required keys.
   *   • `requiredEnv` — the declared list (for form rendering).
   */
  listStatus(): readonly MCPServerStatus[] {
    const configs = this.store.list();
    return configs.map((cfg) => {
      const connected = this.servers.get(cfg.name);
      const required = requiredEnvFor(cfg.name);
      const env = cfg.env ?? {};
      // A key is "configured" if we can resolve a real value for it —
      // either an inline non-empty literal in mcp.json OR a vault entry.
      // The vault check keeps sensitive tokens encrypted on disk while
      // still counting toward readiness.
      const missingEnv = required.filter((k) => {
        const inline = env[k];
        if (inline && inline !== "") return false;
        if (this.vault?.has(k)) return false;
        return true;
      });
      const configured = missingEnv.length === 0;
      const status = connected?.status ?? "disconnected";

      const argFields: MCPArgFieldStatus[] = argFieldsFor(cfg.name).map((f) => ({
        index: f.index,
        label: f.label,
        kind: f.kind ?? "text",
        ...(f.hint ? { hint: f.hint } : {}),
        value: cfg.args?.[f.index] ?? "",
      }));

      const result: MCPServerStatus = {
        name: cfg.name,
        status,
        transport: cfg.command ? "stdio" : cfg.url ? "http" : "unknown",
        tools: (connected?.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
        enabled: cfg.enabled !== false,
        connected: status === "connected",
        configured,
        requiredEnv: [...required],
        missingEnv,
        argFields,
        ...(descriptionFor(cfg.name) ? { description: descriptionFor(cfg.name)! } : {}),
      };
      if (connected?.error) result.error = connected.error;
      return result;
    });
  }

  /** All tools from all connected servers. */
  allTools(): readonly MCPTool[] {
    const tools: MCPTool[] = [];
    for (const entry of this.servers.values()) {
      if (entry.status === "connected") tools.push(...entry.tools);
    }
    return tools;
  }

  /** Call a tool on a connected server. */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const entry = this.servers.get(serverName);
    if (!entry || entry.status !== "connected") {
      throw new Error(`MCP server "${serverName}" not connected`);
    }

    if (entry.config.command && entry.process) {
      return this.callToolStdio(entry.process, toolName, args);
    }
    if (entry.config.url) {
      // Re-resolve headers every call so refreshed OAuth tokens
      // (pushed into the cache by MCPIntegrationBridge) flow through
      // without requiring a reconnect.
      const freshHeaders = this.resolveEnv(entry.config.headers);
      return this.callToolHttp(entry.config.url, toolName, args, freshHeaders);
    }
    throw new Error(`No transport for MCP server "${serverName}"`);
  }

  /** Stop all servers. */
  async stopAll(): Promise<void> {
    for (const name of Array.from(this.servers.keys())) {
      await this.disconnect(name);
    }
  }

  // ── Stdio transport ───────────────────────────────────────────

  /**
   * Resolve a map of env / header values. Rules:
   *   • Empty strings → try vault.get(key).
   *   • `${VAR}` placeholders → substituted. First try vault for `VAR`,
   *     then process.env as a fallback (keeps JS's env-expansion semantics).
   *   • Non-empty / non-placeholder values pass through unchanged.
   *
   * Keys whose values can't be resolved are dropped so the child
   * process / HTTP request doesn't see ambiguous blanks.
   */
  private resolveEnv(source: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!source) return undefined;
    const out: Record<string, string> = {};
    for (const [key, rawValue] of Object.entries(source)) {
      const resolved = this.resolveOne(key, rawValue);
      if (resolved !== null) out[key] = resolved;
    }
    return out;
  }

  private resolveOne(key: string, raw: string): string | null {
    // Empty → vault lookup.
    if (!raw) {
      const v = this.vault?.get(key)?.reveal();
      return v ?? null;
    }
    // Placeholder expansion. Two placeholder forms are supported:
    //   ${INTEGRATION:<id>} — live OAuth token for a connected
    //     integration, served by MCPIntegrationBridge's in-memory
    //     cache (so refreshed tokens propagate without a reconnect).
    //   ${VAR}              — classic env-var expansion, preferring
    //     vault-stored values over process.env.
    if (raw.includes("${")) {
      // Run the INTEGRATION form first so the regex below doesn't
      // swallow the `:id` part as an invalid env-var name.
      const withIntegration = raw.replace(/\$\{INTEGRATION:([A-Z0-9_\-]+)\}/gi, (_, id: string) => {
        const tok = this.integrationToken?.(id.toLowerCase());
        return tok ?? "";
      });
      return withIntegration.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => {
        const fromVault = this.vault?.get(name)?.reveal();
        if (fromVault) return fromVault;
        return process.env[name] ?? "";
      });
    }
    // Plain literal.
    return raw;
  }

  private async discoverToolsStdio(child: ChildProcess, serverName: string): Promise<MCPTool[]> {
    // `initialize` gets the long (cold-start) budget because `npx -y`
    // may need to download the server package on first run. Subsequent
    // calls on the same child reuse the warm cache and finish fast.
    const result = await this.jsonRpcStdio(child, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "daemora", version: "1.0.0" },
    }, 60_000);

    if (!result) return [];

    // `notifications/initialized` is fire-and-forget — no id, no response.
    child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const toolsResult = await this.jsonRpcStdio(child, "tools/list", {}, 30_000);
    const tools = ((toolsResult as {
      tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
    })?.tools ?? []);

    return tools.map((t) => ({
      serverName,
      name: t.name,
      fullName: `mcp__${serverName}__${t.name}`,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? {},
    }));
  }

  /**
   * JSON-RPC over stdio with proper line framing.
   *
   * Why the buffer: stdout `data` events deliver arbitrary chunks — a
   * single JSON-RPC frame can span multiple `data` callbacks, and a
   * single callback can deliver multiple frames. The previous impl
   * split each chunk on `\n` which dropped frames that straddled the
   * boundary and misparsed any half-line remainder.
   *
   * We accumulate into `buf`, split on newlines, keep the trailing
   * partial in `buf`, and parse each complete line as JSON.
   */
  private jsonRpcStdio(
    child: ChildProcess,
    method: string,
    params: unknown,
    timeoutMs = 15_000,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextRpcId();
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

      let buf = "";
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`MCP stdio timeout for ${method} after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      const onData = (chunk: Buffer) => {
        buf += chunk.toString("utf-8");
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let resp: { id?: number; result?: unknown; error?: { message?: string } };
          try {
            resp = JSON.parse(line);
          } catch {
            continue; // non-JSON line — many servers log here.
          }
          if (resp.id !== id) continue;
          cleanup();
          if (resp.error) reject(new Error(resp.error.message ?? "MCP error"));
          else resolve(resp.result);
          return;
        }
      };

      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`MCP server exited before responding to ${method} (code=${code})`));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        child.stdout?.off("data", onData);
        child.off("exit", onExit);
      };

      child.stdout?.on("data", onData);
      child.once("exit", onExit);
      child.stdin?.write(msg);
    });
  }

  /**
   * Monotonic per-process id generator. Using `Date.now()` per call
   * created collisions on fast back-to-back requests (same ms ticks).
   */
  private rpcIdSeq = 0;
  private nextRpcId(): number {
    return ++this.rpcIdSeq;
  }

  private async callToolStdio(child: ChildProcess, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.jsonRpcStdio(child, "tools/call", { name: toolName, arguments: args });
    return result;
  }

  // ── HTTP transport ────────────────────────────────────────────

  private async discoverToolsHttp(url: string, serverName: string, headers?: Record<string, string>): Promise<MCPTool[]> {
    const base = url.replace(/\/+$/, "");

    // Try MCP Streamable HTTP (POST with JSON-RPC)
    const initResp = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(headers ?? {}) },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "daemora", version: "1.0.0" } },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!initResp.ok) throw new Error(`MCP HTTP init ${initResp.status}`);

    // Send tools/list
    const toolsResp = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(headers ?? {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!toolsResp.ok) throw new Error(`MCP HTTP tools/list ${toolsResp.status}`);
    const data = (await toolsResp.json()) as { result?: { tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[] } };

    return (data.result?.tools ?? []).map((t) => ({
      serverName,
      name: t.name,
      fullName: `mcp__${serverName}__${t.name}`,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? {},
    }));
  }

  private async callToolHttp(url: string, toolName: string, args: Record<string, unknown>, headers?: Record<string, string>): Promise<unknown> {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(headers ?? {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: toolName, arguments: args } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) throw new Error(`MCP tool call ${resp.status}`);
    const data = (await resp.json()) as { result?: unknown; error?: { message: string } };
    if (data.error) throw new Error(data.error.message);
    return data.result;
  }
}
