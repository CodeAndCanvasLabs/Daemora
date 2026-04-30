/**
 * Registers every integration-sourced tool with the ToolRegistry.
 *
 * Must be called BEFORE CrewLoader runs so crew manifests in
 * `crew/<integration>/plugin.json` can resolve their tool names
 * cleanly (otherwise the loader marks them as "dropped" with a warning).
 *
 * Each tool's `source` is `{ kind: "integration", id: <integration> }`
 * so `ToolRegistry.available(enabledIntegrations)` can hide them from
 * the model until the user connects the service.
 *
 * NOTE: GitHub and Notion intentionally have NO native tools here —
 * their coverage lives in the remote MCP servers wired up by
 * MCPIntegrationBridge. Their crews reference `mcp__github__*` and
 * `mcp__notion__*` tools which route through the MCP transport.
 */

import type { ToolRegistry } from "../tools/registry.js";
import type { ToolDef } from "../tools/types.js";
import { makeFacebookTools } from "./facebook/tools.js";
import { makeGmailTools } from "./gmail/tools.js";
import { makeCalendarTools } from "./google-calendar/tools.js";
import { makeInstagramTools } from "./instagram/tools.js";
import type { IntegrationManager } from "./IntegrationManager.js";
import { makeLinkedInTools } from "./linkedin/tools.js";
import { makeRedditTools } from "./reddit/tools.js";
import { makeTikTokTools } from "./tiktok/tools.js";
import { makeTwitterTools } from "./twitter/tools.js";
import type { IntegrationId } from "./types.js";
import { makeYouTubeTools } from "./youtube/tools.js";

export function registerIntegrationTools(
  integrations: IntegrationManager,
  registry: ToolRegistry,
): void {
  const all: ToolDef[] = [
    ...mark(makeTwitterTools(integrations), "twitter"),
    ...mark(makeYouTubeTools(integrations), "youtube"),
    ...mark(makeFacebookTools(integrations), "facebook"),
    ...mark(makeInstagramTools(integrations), "instagram"),
    ...mark(makeGmailTools(integrations), "gmail"),
    ...mark(makeCalendarTools(integrations), "google_calendar"),
    ...mark(makeRedditTools(integrations), "reddit"),
    ...mark(makeLinkedInTools(integrations), "linkedin"),
    ...mark(makeTikTokTools(integrations), "tiktok"),
  ];
  registry.registerAll(all);
}

function mark(defs: readonly ToolDef[], id: IntegrationId): ToolDef[] {
  return defs.map((d) => ({ ...d, source: { kind: "integration" as const, id } }));
}
