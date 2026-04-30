/**
 * MCPIntegrationBridge — pipes OAuth access tokens from
 * IntegrationManager into MCPManager so remote MCP servers
 * (GitHub, Notion, …) authenticate against the user's connected
 * accounts without ever writing the token to disk.
 *
 * How it works:
 *   • A small in-memory `tokenCache` maps integration id → current
 *     access token.
 *   • The bridge installs a lookup function on MCPManager via
 *     `setIntegrationTokenProvider()`. MCPManager's `${INTEGRATION:<id>}`
 *     placeholder expansion reads from that function on every call.
 *   • On `IntegrationManager` lifecycle events (`connected`,
 *     `refreshed`, `disconnected`) we update the cache and, for
 *     integrations bound to an MCP server, toggle the server's
 *     enabled state + reconnect it so discovery runs with a valid
 *     credential.
 *
 * This keeps MCPManager unaware of the OAuth machinery and keeps
 * IntegrationManager unaware of MCP — the bridge is the only place
 * they meet.
 */

import { createLogger } from "../util/logger.js";
import type { IntegrationManager } from "../integrations/IntegrationManager.js";
import type { IntegrationId } from "../integrations/types.js";
import type { MCPManager } from "./MCPManager.js";
import type { MCPStore } from "./MCPStore.js";

const log = createLogger("mcp.bridge");

/**
 * Integrations that are backed by a remote MCP server rather than a
 * native REST client. The value is the MCP server name (as it appears
 * in mcp.json / defaults.ts).
 */
const INTEGRATION_TO_MCP: Partial<Record<IntegrationId, string>> = {
  github: "github",
  notion: "notion",
};

export class MCPIntegrationBridge {
  /** integration id (lowercase) → current OAuth access token. */
  private readonly tokenCache = new Map<string, string>();

  constructor(
    private readonly integrations: IntegrationManager,
    private readonly mcp: MCPManager,
    private readonly mcpStore: MCPStore,
  ) {
    this.mcp.setIntegrationTokenProvider((id) => this.tokenCache.get(id.toLowerCase()));
    void this.seedFromConnected();
    this.subscribe();
  }

  /** On startup, prime the cache from already-connected accounts. */
  private async seedFromConnected(): Promise<void> {
    const accounts = this.integrations.listAccounts();
    for (const a of accounts) {
      if (!(a.integration in INTEGRATION_TO_MCP)) continue;
      await this.refreshToken(a.integration);
    }
    // Re-connect any MCP servers whose token we just cached so
    // discovery sees the credential. If the server is disabled in
    // mcp.json we leave it alone — user opt-in still wins.
    for (const integration of Object.keys(INTEGRATION_TO_MCP) as IntegrationId[]) {
      if (!this.tokenCache.has(integration)) continue;
      await this.reconnectMcpFor(integration);
    }
  }

  private subscribe(): void {
    this.integrations.on("connected", async (ev: { integration: IntegrationId }) => {
      if (!(ev.integration in INTEGRATION_TO_MCP)) return;
      await this.refreshToken(ev.integration);
      await this.ensureEnabledAndReconnect(ev.integration);
    });
    this.integrations.on("refreshed", async (ev: { integration: IntegrationId }) => {
      if (!(ev.integration in INTEGRATION_TO_MCP)) return;
      await this.refreshToken(ev.integration);
      // No reconnect needed — MCPManager re-resolves headers on every
      // HTTP call, so the new token is picked up automatically.
    });
    this.integrations.on("disconnected", async (ev: { integration: IntegrationId }) => {
      if (!(ev.integration in INTEGRATION_TO_MCP)) return;
      // Only clear if the user removed the last account for this
      // integration — multiple accounts under one integration share
      // one token cache slot (most-recent wins), so while other
      // accounts remain we just refresh to the next one.
      const stillHas = this.integrations.listAccounts(ev.integration).length > 0;
      if (stillHas) {
        await this.refreshToken(ev.integration);
        return;
      }
      this.tokenCache.delete(ev.integration);
      const serverName = INTEGRATION_TO_MCP[ev.integration];
      if (!serverName) return;
      this.mcpStore.setEnabled(serverName, false);
      await this.mcp.disconnect(serverName);
      log.info({ integration: ev.integration, server: serverName }, "MCP server disabled on integration disconnect");
    });
  }

  private async refreshToken(integration: IntegrationId): Promise<void> {
    const token = await this.integrations.getAccessToken(integration);
    if (token) this.tokenCache.set(integration, token);
    else this.tokenCache.delete(integration);
  }

  private async ensureEnabledAndReconnect(integration: IntegrationId): Promise<void> {
    const serverName = INTEGRATION_TO_MCP[integration];
    if (!serverName) return;
    const cfg = this.mcpStore.get(serverName);
    if (!cfg) {
      log.warn({ integration, server: serverName }, "MCP server not in config — skipping enable");
      return;
    }
    if (cfg.enabled === false) this.mcpStore.setEnabled(serverName, true);
    await this.reconnectMcpFor(integration);
  }

  private async reconnectMcpFor(integration: IntegrationId): Promise<void> {
    const serverName = INTEGRATION_TO_MCP[integration];
    if (!serverName) return;
    const cfg = this.mcpStore.get(serverName);
    if (!cfg || cfg.enabled === false) return;
    try {
      await this.mcp.connect(cfg);
      log.info({ integration, server: serverName }, "MCP server reconnected with fresh integration token");
    } catch (e) {
      log.error({ integration, server: serverName, err: (e as Error).message }, "MCP reconnect failed");
    }
  }
}
