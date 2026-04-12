/**
 * Core tools + defaults for agent orchestration.
 *
 * Profiles are now defined in crew plugin.json files (unified crew system).
 * This file only defines: CORE_TOOLS for main agent + defaultSubAgentTools fallback.
 *
 * Usage: useCrew("coder", task) / parallelCrew([...]) / teamTask(...)
 */

// Legacy profile objects - kept for reference only, not used by ProfileLoader.
// Profiles now live in crew/*/plugin.json.
const _legacyProfiles = {

  /**
   * researcher - gather, analyze, summarize, produce findings.
   * Reads files, searches web, fetches URLs, analyzes images. Saves findings to files.
   * Does NOT ask the user what to look for - searches until it has enough to answer fully.
   * Produces structured output: facts, sources, analysis, recommendations.
   */
  researcher: [
    "readFile", "listDirectory",
    "glob", "grep",
    "webFetch", "webSearch",
    "writeFile",        // save research notes and findings to workspace
    "createDocument",   // produce reports
    "readMemory", "writeMemory", "searchMemory",
    "imageAnalysis",    // analyze charts, diagrams, screenshots, visual data
    "useMCP",           // query external sources (GitHub, Notion, Linear, etc.)
    "teamTask",         // team coordination (shared tasks, messaging)
    "replyToUser",      // mid-task progress updates
  ],

  /**
   * coder - build, fix, test, verify.
   * Full ownership: writes code, runs builds, starts dev servers, tests UI visually,
   * writes test cases, runs them, fixes failures. Does everything without asking the user.
   */
  coder: [
    "readFile", "writeFile", "editFile", "listDirectory",
    "glob", "grep", "applyPatch",
    "executeCommand",
    "webFetch", "webSearch",
    "browserAction",    // test web UIs, click, fill forms, navigate
    "imageAnalysis",    // analyze screenshots for visual bugs, verify UI looks correct
    "screenCapture",    // capture screen when browser isn't sufficient
    "readMemory", "writeMemory", "searchMemory",  // learn and apply project conventions
    "projectTracker",   // track sub-tasks within complex coding work
    "useMCP",
    "teamTask",         // team coordination (shared tasks, messaging)
    "replyToUser",      // mid-task progress updates
  ],

  /**
   * writer - produce polished documents, reports, content.
   * Reads existing content for context, researches via web, produces clean output.
   * Does NOT ask what tone/format to use unless genuinely ambiguous - infers from context.
   * Delivers the final document, not a draft asking for feedback.
   */
  writer: [
    "readFile", "writeFile", "editFile", "listDirectory",
    "glob", "grep",
    "webFetch", "webSearch",
    "createDocument",
    "readMemory", "writeMemory", "searchMemory",
    "teamTask",         // team coordination (shared tasks, messaging)
    "replyToUser",      // mid-task progress updates
  ],

  /**
   * analyst - process data, run scripts, extract insights, produce output.
   * Shell execution for data processing + web + vision for charts/visuals.
   * Runs scripts, parses output, draws conclusions. Delivers findings, not raw data.
   */
  analyst: [
    "readFile", "writeFile", "listDirectory",
    "glob", "grep",
    "webFetch", "webSearch",
    "executeCommand",   // run data processing scripts, query CLIs
    "imageAnalysis",    // analyze charts, graphs, visual data
    "createDocument",   // produce analysis reports
    "readMemory", "writeMemory", "searchMemory",
    "teamTask",         // team coordination (shared tasks, messaging)
    "replyToUser",      // mid-task progress updates
  ],

};

/**
 * Default tool set for sub-agents spawned without a profile.
 *
 * Covers the majority of tasks while excluding high-blast-radius tools
 * that sub-agents rarely need and that carry side effects beyond task scope:
 *   - cron          - schedules recurring tasks that outlive the sub-agent
 *   - sendEmail     - sub-agents shouldn't initiate email
 *   - messageChannel - sub-agents shouldn't send messages
 *   - screenCapture - sub-agents don't need screen access
 *   - manageAgents  - sub-agents shouldn't kill/steer other agents
 *   - delegateToAgent - A2A from sub-agents is unpredictable
 *
 * spawnAgent and parallelAgents are NOT available to sub-agents - they are removed
 * dynamically into sub-agents by SubAgentManager based on recursion depth.
 */
/**
 * Core tools - always available to the main agent.
 * Rule: if it needs an API key or external service, it's NOT core.
 * Everything else goes through profiles (sub-agents).
 */
export const CORE_TOOLS = [
  // File I/O
  "readFile", "writeFile", "editFile", "listDirectory",
  "glob", "grep", "applyPatch",
  // Shell
  "executeCommand",
  // Web
  "webFetch", "webSearch",
  // Memory
  "readMemory", "writeMemory", "searchMemory",
  // Orchestration
  "parallelCrew", "manageAgents", "teamTask", "discoverCrew",
  // Communication
  "replyToUser",
  "sendFile",
  // Tasks
  "taskManager", "cron", "goal", "watcher",
  // MCP + Crew
  "useMCP", "useCrew",
  // Image processing (local, no API key)
  "imageOps",
  // Desktop control (via local sidecar — PyAutoGUI, screenshot, keyboard, mouse, vision findElement)
  "desktopScreenshot", "desktopListWindows", "desktopFocusWindow", "desktopFindElement",
  "desktopClick", "desktopMove", "desktopType", "desktopPressKey", "desktopKeyCombo", "desktopScroll",
];

export const defaultSubAgentTools = [
  // File
  "readFile", "writeFile", "editFile", "listDirectory",
  "glob", "grep", "applyPatch",
  // System
  "executeCommand",
  // Web
  "webFetch", "webSearch",
  // Browser
  "browserAction",
  // Documents + Vision
  "createDocument",
  "imageAnalysis",
  // Memory
  "readMemory", "writeMemory", "readDailyLog", "writeDailyLog",
  "searchMemory", "pruneMemory", "listMemoryCategories",
  // Project tracking
  "projectTracker",
  "taskManager",
  // Communication
  "replyToUser",
  // Delegation
  "useMCP",
  "useCrew",
];
