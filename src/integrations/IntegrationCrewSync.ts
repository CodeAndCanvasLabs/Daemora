/**
 * IntegrationCrewSync — keeps integration-owned crews hidden from
 * the CrewRegistry until the user connects the service.
 *
 * The crew manifests live on disk at `crew/twitter|youtube|facebook|
 * instagram/plugin.json`. CrewLoader picks them up at startup; this
 * class immediately stages them out of the active registry and only
 * puts them back when the corresponding integration has ≥1 connected
 * account. On disconnect of the last account, the crew goes back
 * into the stage.
 *
 * Tools are registered separately in `integrations/tools.ts` (called
 * before CrewLoader). This class owns only the crew show/hide logic.
 */

import type { AgentLoop } from "../core/AgentLoop.js";
import type { CrewRegistry } from "../crew/CrewRegistry.js";
import type { LoadedCrew } from "../crew/types.js";
import { createLogger } from "../util/logger.js";
import type { IntegrationManager } from "./IntegrationManager.js";
import type { IntegrationId } from "./types.js";

const log = createLogger("integrations.crew");

/** Which CrewRegistry id belongs to which integration. */
const INTEGRATION_TO_CREW: Record<IntegrationId, string> = {
  twitter: "twitter-crew",
  youtube: "youtube-crew",
  facebook: "facebook-crew",
  instagram: "instagram-crew",
  github: "github-crew",
  notion: "notion-crew",
  gmail: "gmail-crew",
  google_calendar: "google-calendar-crew",
  reddit: "reddit-crew",
  linkedin: "linkedin-crew",
  tiktok: "tiktok-crew",
};

export class IntegrationCrewSync {
  /** Filesystem-loaded crews held out of CrewRegistry until connected. */
  private readonly staged = new Map<IntegrationId, LoadedCrew>();

  constructor(
    private readonly integrations: IntegrationManager,
    private readonly crews: CrewRegistry,
    private readonly agent: AgentLoop,
  ) {
    this.stageIntegrationCrews();
    this.restoreAlreadyConnected();
    this.subscribeToLifecycle();
  }

  /** Move each integration crew out of CrewRegistry into the stage. */
  private stageIntegrationCrews(): void {
    for (const [integration, crewId] of Object.entries(INTEGRATION_TO_CREW) as Array<[IntegrationId, string]>) {
      const crew = this.crews.tryGet(crewId);
      if (!crew) continue;
      this.staged.set(integration, crew);
      this.crews.unregister(crewId);
      log.debug({ integration, crewId }, "integration crew staged (hidden until connected)");
    }
  }

  /** Register crews for integrations already connected (tokens persist). */
  private restoreAlreadyConnected(): void {
    for (const account of this.integrations.listAccounts()) {
      this.reveal(account.integration);
    }
  }

  private subscribeToLifecycle(): void {
    this.integrations.on("connected", ({ integration }: { integration: IntegrationId }) => {
      this.reveal(integration);
      this.agent.invalidateSystemPromptCache();
    });
    this.integrations.on("disconnected", ({ integration }: { integration: IntegrationId }) => {
      // Keep the crew visible if any accounts for this integration
      // remain (a user can have multiple IG accounts under one Meta
      // connection).
      const stillHas = this.integrations.listAccounts(integration).length > 0;
      if (stillHas) return;
      this.hide(integration);
      this.agent.invalidateSystemPromptCache();
    });
  }

  private reveal(integration: IntegrationId): void {
    const crew = this.staged.get(integration);
    if (!crew) return;
    if (this.crews.has(crew.manifest.id)) return; // already visible
    this.crews.register(crew);
    log.info({ crew: crew.manifest.id }, "integration crew revealed");
  }

  private hide(integration: IntegrationId): void {
    const crewId = INTEGRATION_TO_CREW[integration];
    if (!crewId) return;
    const removed = this.crews.unregister(crewId);
    if (removed) log.info({ crewId }, "integration crew hidden (disconnected)");
  }
}
