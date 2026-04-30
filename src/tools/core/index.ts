import type { ChannelManager } from "../../channels/ChannelManager.js";
import type { ConfigManager } from "../../config/ConfigManager.js";
import type { CrewRegistry } from "../../crew/CrewRegistry.js";
import type { CronScheduler } from "../../cron/CronScheduler.js";
import type { CronStore } from "../../cron/CronStore.js";
import type { GoalStore } from "../../goals/GoalStore.js";
import type { MCPManager } from "../../mcp/MCPManager.js";
import type { MCPStore } from "../../mcp/MCPStore.js";
import type { DeclarativeMemoryStore } from "../../memory/DeclarativeMemoryStore.js";
import type { EventBus } from "../../events/eventBus.js";
import type { MemoryStore } from "../../memory/MemoryStore.js";
import type { SessionStore } from "../../memory/SessionStore.js";
import type { ModelRouter } from "../../models/ModelRouter.js";
import type { ProjectStore } from "../../projects/ProjectStore.js";
import type { FilesystemGuard } from "../../safety/FilesystemGuard.js";
import type { SkillLoader } from "../../skills/SkillLoader.js";
import type { SkillRegistry } from "../../skills/SkillRegistry.js";
import type { TeamStore } from "../../teams/TeamStore.js";
import type { WatcherStore } from "../../watchers/WatcherStore.js";
import type { ToolDef } from "../types.js";

import { makeApplyPatchTool } from "./applyPatch.js";
import { makeBroadcastTool } from "./broadcast.js";
import { clipboardTool } from "./clipboard.js";
import { makeCreateDocumentTool } from "./createDocument.js";
import { makeCronTool } from "./cronTool.js";
import { makeDesktopTools } from "./desktop.js";
import { makeEditFileTool } from "./editFile.js";
import { makeExecuteCommandTool } from "./executeCommand.js";
import { fetchUrlTool } from "./fetchUrl.js";
import { makeGenerateImageTool } from "./generateImage.js";
import { makeGenerateMusicTool } from "./generateMusic.js";
import { makeGenerateVideoTool } from "./generateVideo.js";
import { makeGitTool } from "./gitTool.js";
import { makeGlobTool } from "./glob.js";
import { makeGoalTool } from "./goalTool.js";
import { makeGrepTool } from "./grep.js";
import { makeImageAnalysisTool } from "./imageAnalysis.js";
import { makeImageOpsTool } from "./imageOps.js";
import { makeListDirectoryTool } from "./listDirectory.js";
import { makeManageAgentsTool } from "./manageAgents.js";
import { makeManageMCPTool } from "./manageMCP.js";
import { makeMemoryTool } from "./memory.js";
import { makeMemoryRecallTool } from "./memoryRecall.js";
import { makeMemorySaveTool } from "./memorySave.js";
import { makeMessageChannelTool } from "./messageChannel.js";
import { makePollTool } from "./pollTool.js";
import { makeProjectTool } from "./projectTracker.js";
import { makeReadFileTool } from "./readFile.js";
import { makeReadPDFTool } from "./readPDF.js";
import { makeReloadTool } from "./reloadTool.js";
import { replyToUserTool } from "./replyToUser.js";
import { screenCaptureTool } from "./screenCapture.js";
// Resend-backed email tool disabled — Gmail integration is the preferred
// outbound path. Left in place so it can be re-enabled without
// reinstating the file.
// import { makeSendEmailTool } from "./sendEmail.js";
import { makeSendFileTool } from "./sendFile.js";
import { makeSessionSearchTool } from "./sessionSearch.js";
import { makeSkillManageTool } from "./skillManage.js";
import { makeSkillViewTool } from "./skillView.js";
import { makeTeamTool } from "./teamTool.js";
import { makeTextToSpeechTool } from "./textToSpeech.js";
import { makeTranscribeAudioTool } from "./transcribeAudio.js";
import { makeUseMCPTool } from "./useMCP.js";
import { makeWatcherTool } from "./watcherTool.js";
import { makeWebFetchTool } from "./webFetch.js";
import { makeWebSearchTool } from "./webSearch.js";
import { makeWriteFileTool } from "./writeFile.js";

export interface CoreToolDeps {
  readonly cfg: ConfigManager;
  readonly guard: FilesystemGuard;
  readonly memory: MemoryStore;
  readonly declarativeMemory?: DeclarativeMemoryStore;
  readonly models?: ModelRouter;
  readonly bus?: EventBus;
  readonly mcp?: MCPManager;
  readonly mcpStore?: MCPStore;
  readonly cronStore?: CronStore;
  readonly cronScheduler?: CronScheduler;
  readonly goals?: GoalStore;
  readonly watchers?: WatcherStore;
  readonly sessions?: SessionStore;
  readonly crews?: CrewRegistry;
  readonly channels?: ChannelManager;
  readonly teams?: TeamStore;
  readonly projects?: ProjectStore;
  readonly skills?: SkillRegistry;
  readonly skillLoader?: SkillLoader;
  readonly skillsRoot?: string;
  /** Called after skill_manage writes so the registry can be rebuilt. */
  readonly onSkillsChanged?: () => Promise<void> | void;
}

/**
 * Build the full core tool set. Crew tools (use_crew / parallel_crew)
 * are added post-construction via AgentLoop.installCrews().
 */
export function buildCoreTools(deps: CoreToolDeps): readonly ToolDef[] {
  return [
    // Filesystem
    makeReadFileTool(deps.guard) as unknown as ToolDef,
    makeWriteFileTool(deps.guard) as unknown as ToolDef,
    makeEditFileTool(deps.guard) as unknown as ToolDef,
    makeApplyPatchTool(deps.guard) as unknown as ToolDef,
    makeListDirectoryTool(deps.guard) as unknown as ToolDef,
    makeGlobTool(deps.guard) as unknown as ToolDef,
    makeGrepTool(deps.guard) as unknown as ToolDef,
    makeCreateDocumentTool(deps.guard) as unknown as ToolDef,
    ...(deps.models ? [makeReadPDFTool(deps.guard, deps.models) as unknown as ToolDef] : []),

    // Shell
    makeExecuteCommandTool(deps.guard) as unknown as ToolDef,

    // Network
    fetchUrlTool as unknown as ToolDef,
    makeWebFetchTool(deps.cfg) as unknown as ToolDef,
    makeWebSearchTool(deps.cfg) as unknown as ToolDef,

    // Memory — tagged notebook (FTS5)
    makeMemorySaveTool(deps.memory) as unknown as ToolDef,
    makeMemoryRecallTool(deps.memory) as unknown as ToolDef,

    // Declarative memory (MEMORY.md + USER.md) — hermes pattern
    ...(deps.declarativeMemory
      ? [makeMemoryTool(deps.declarativeMemory, deps.bus) as unknown as ToolDef]
      : []),

    // Session search — cross-session recall via FTS5 + cheap-LLM summarize
    ...(deps.sessions && deps.models
      ? [makeSessionSearchTool({ sessions: deps.sessions, models: deps.models }) as unknown as ToolDef]
      : []),

    // AI services
    makeImageAnalysisTool(deps.cfg) as unknown as ToolDef,
    makeTranscribeAudioTool(deps.cfg) as unknown as ToolDef,
    makeTextToSpeechTool(deps.cfg) as unknown as ToolDef,
    makeGenerateImageTool(deps.cfg) as unknown as ToolDef,

    // Media processing (local, no API)
    makeImageOpsTool(deps.guard) as unknown as ToolDef,

    // System
    clipboardTool as unknown as ToolDef,
    screenCaptureTool as unknown as ToolDef,
    replyToUserTool as unknown as ToolDef,

    // Communication
    // Resend-backed `send_email` disabled — use the Gmail integration instead.
    // makeSendEmailTool(deps.cfg) as unknown as ToolDef,

    // MCP integration
    ...(deps.mcp ? [makeUseMCPTool(deps.mcp) as unknown as ToolDef] : []),

    // Desktop control — mouse, keyboard, windows, screenshot (via sidecar)
    ...makeDesktopTools(deps.cfg),

    // Agent / system management (each tool wires only if its backing
    // store was handed in by the caller — keeps the tool list honest
    // for callers that don't run the full server).
    ...(deps.cronStore && deps.cronScheduler
      ? [makeCronTool(deps.cronStore, deps.cronScheduler) as unknown as ToolDef]
      : []),
    ...(deps.goals ? [makeGoalTool(deps.goals) as unknown as ToolDef] : []),
    ...(deps.watchers ? [makeWatcherTool(deps.watchers) as unknown as ToolDef] : []),
    ...(deps.mcp && deps.mcpStore
      ? [makeManageMCPTool(deps.mcpStore, deps.mcp) as unknown as ToolDef]
      : []),
    ...(deps.sessions && deps.crews
      ? [makeManageAgentsTool({ sessions: deps.sessions, crews: deps.crews }) as unknown as ToolDef]
      : []),
    ...(deps.mcp && deps.mcpStore && deps.cronScheduler && deps.channels
      ? [makeReloadTool({ mcp: deps.mcp, mcpStore: deps.mcpStore, scheduler: deps.cronScheduler, channels: deps.channels }) as unknown as ToolDef]
      : []),
    ...(deps.channels ? [makePollTool(deps.channels) as unknown as ToolDef] : []),

    // Outbound communication — message, file delivery, broadcast.
    ...(deps.channels
      ? [
          makeMessageChannelTool(deps.channels) as unknown as ToolDef,
          makeSendFileTool(deps.guard, deps.channels) as unknown as ToolDef,
          makeBroadcastTool(deps.channels, deps.guard) as unknown as ToolDef,
        ]
      : []),

    // Team orchestration
    ...(deps.teams ? [makeTeamTool(deps.teams) as unknown as ToolDef] : []),

    // Project planning — long-running multi-step task tracking
    ...(deps.projects ? [makeProjectTool(deps.projects) as unknown as ToolDef] : []),

    // Skills — hermes-pattern progressive disclosure: flat index in system
    // prompt, `skill_view` loads body on demand, `skill_manage` lets the
    // agent (and the background reviewer) curate its own skill library.
    ...(deps.skills
      ? [makeSkillViewTool(deps.skills, (key) => {
          // Look up skills.<id>.<key> then plain key in the generic settings store.
          return deps.cfg.settings.hasGeneric(key)
            ? deps.cfg.settings.getGeneric(key)
            : undefined;
        }) as unknown as ToolDef]
      : []),
    ...(deps.skills && deps.skillLoader && deps.skillsRoot
      ? [
          makeSkillManageTool({
            registry: deps.skills,
            loader: deps.skillLoader,
            skillsRoot: deps.skillsRoot,
            ...(deps.bus ? { bus: deps.bus } : {}),
            ...(deps.onSkillsChanged ? { onChange: deps.onSkillsChanged } : {}),
          }) as unknown as ToolDef,
        ]
      : []),

    // Shell + integrations
    makeGitTool(deps.guard) as unknown as ToolDef,

    // Generative media
    makeGenerateVideoTool(deps.cfg, deps.guard) as unknown as ToolDef,
    makeGenerateMusicTool(deps.cfg, deps.guard) as unknown as ToolDef,
  ];
}
