/**
 * MCPStore — config persistence for MCP server connections.
 *
 * MCP servers are stored in a JSON file (config/mcp.json) just like
 * the JS version. Each server entry declares how to connect (stdio
 * command or HTTP URL) plus optional env vars and headers.
 *
 * The actual MCP client connection lives in MCPManager — this module
 * only handles config CRUD.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createLogger } from "../util/logger.js";
import { BUILTIN_MCP_SERVERS } from "./defaults.js";

const log = createLogger("mcp.store");

export interface MCPServerConfig {
  /** Shell command for stdio transport. Mutually exclusive with `url`. */
  command?: string;
  args?: string[];
  /** HTTP URL for streamable-http or SSE transport. */
  url?: string;
  /** Transport type. Auto-detected if omitted: command → stdio, url → http. */
  transport?: "stdio" | "http" | "sse";
  /** Environment variables passed to the subprocess (stdio only). */
  env?: Record<string, string>;
  /** HTTP headers (http/sse only). */
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface MCPServerEntry extends MCPServerConfig {
  name: string;
}

interface MCPConfigFile {
  mcpServers: Record<string, MCPServerConfig>;
}

export class MCPStore {
  private configPath: string;
  private data: MCPConfigFile;

  constructor(dataDir: string) {
    this.configPath = join(dataDir, "mcp.json");
    this.data = this.load();
  }

  private load(): MCPConfigFile {
    // First boot: seed the mcp.json with the built-in server catalog
    // (all disabled). The user enables whatever they want from the
    // manage_mcp tool or the Settings UI.
    if (!existsSync(this.configPath)) {
      const seeded: MCPConfigFile = { mcpServers: { ...BUILTIN_MCP_SERVERS } };
      try {
        const dir = dirname(this.configPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(this.configPath, JSON.stringify(seeded, null, 2), "utf-8");
        log.info({ path: this.configPath, seeded: Object.keys(seeded.mcpServers).length }, "mcp.json seeded with defaults");
      } catch (e) {
        log.warn({ err: (e as Error).message }, "mcp.json seed write failed");
      }
      return seeded;
    }
    try {
      const raw = readFileSync(this.configPath, "utf-8");
      const parsed = JSON.parse(raw) as MCPConfigFile;
      return { mcpServers: parsed.mcpServers ?? {} };
    } catch (e) {
      log.warn({ path: this.configPath, err: (e as Error).message }, "mcp.json parse failed, starting fresh");
      return { mcpServers: {} };
    }
  }

  private save(): void {
    const dir = dirname(this.configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(this.data, null, 2), "utf-8");
  }

  list(): readonly MCPServerEntry[] {
    return Object.entries(this.data.mcpServers)
      .filter(([name]) => !name.startsWith("_comment"))
      .map(([name, cfg]) => ({ name, ...cfg }));
  }

  get(name: string): MCPServerEntry | null {
    const cfg = this.data.mcpServers[name];
    if (!cfg) return null;
    return { name, ...cfg };
  }

  add(name: string, config: MCPServerConfig): MCPServerEntry {
    if (this.data.mcpServers[name]) {
      throw new Error(`MCP server "${name}" already exists`);
    }
    this.data.mcpServers[name] = { ...config, enabled: config.enabled ?? true };
    this.save();
    log.info({ name, transport: config.command ? "stdio" : "http" }, "MCP server added");
    return { name, ...this.data.mcpServers[name]! };
  }

  update(name: string, updates: Partial<MCPServerConfig>): MCPServerEntry | null {
    const existing = this.data.mcpServers[name];
    if (!existing) return null;
    Object.assign(existing, updates);
    this.save();
    return { name, ...existing };
  }

  remove(name: string): boolean {
    if (!this.data.mcpServers[name]) return false;
    delete this.data.mcpServers[name];
    this.save();
    log.info({ name }, "MCP server removed");
    return true;
  }

  setEnabled(name: string, enabled: boolean): boolean {
    const existing = this.data.mcpServers[name];
    if (!existing) return false;
    existing.enabled = enabled;
    this.save();
    return true;
  }
}
