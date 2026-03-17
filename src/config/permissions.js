/**
 * Permission tier definitions.
 * Each tier specifies which tools are allowed.
 * Tiers are cumulative: standard includes minimal, full includes standard.
 */
export const permissionTiers = {
  minimal: {
    name: "Minimal (Read-Only)",
    description: "Agent can read files, search, and browse the web - no writes, no shell, no communication.",
    allowedTools: [
      // File reads
      "readFile",
      "listDirectory",
      "searchFiles",
      "searchContent",
      "glob",
      "grep",
      // Web reads
      "webFetch",
      "webSearch",
      // Memory reads
      "readMemory",
      "readDailyLog",
      "searchMemory",
      "listMemoryCategories",
      // Vision (read-only)
      "imageAnalysis",
    ],
  },
  standard: {
    name: "Standard",
    description: "Agent can read + write files, run commands, use browser, and manage memory.",
    allowedTools: [
      // File operations
      "readFile", "writeFile", "editFile", "listDirectory",
      "searchFiles", "searchContent", "glob", "grep", "applyPatch",
      // System
      "executeCommand",
      // Web & browser
      "webFetch", "webSearch", "browserAction",
      // Communication (no sendEmail/messageChannel — those are full-only)
      "sendFile", "replyWithFile", "replyToUser",
      // Media
      "transcribeAudio", "textToSpeech",
      // Documents
      "createDocument",
      // Vision & screen
      "imageAnalysis", "screenCapture",
      // Memory
      "readMemory", "writeMemory", "readDailyLog", "writeDailyLog",
      "searchMemory", "pruneMemory", "listMemoryCategories",
      // Agents & teams
      "spawnAgent", "parallelAgents", "manageAgents",
      "teamTask",
      // MCP
      "manageMCP", "useMCP",
      // Project & task tracking
      "projectTracker", "taskManager",
    ],
  },
  full: {
    name: "Full Access",
    description: "Unrestricted access to all tools including email, messaging, sub-agents, and scheduling.",
    allowedTools: [
      // File operations
      "readFile", "writeFile", "editFile", "listDirectory",
      "searchFiles", "searchContent", "glob", "grep", "applyPatch",
      // System
      "executeCommand",
      // Web & browser
      "webFetch", "webSearch", "browserAction",
      // Communication
      "sendEmail", "messageChannel", "sendFile", "replyWithFile", "replyToUser",
      // Media
      "transcribeAudio", "textToSpeech",
      // Documents
      "createDocument",
      // Vision & screen
      "imageAnalysis", "screenCapture",
      // Memory
      "readMemory", "writeMemory", "readDailyLog", "writeDailyLog",
      "searchMemory", "pruneMemory", "listMemoryCategories",
      // Agents & teams
      "spawnAgent", "parallelAgents", "delegateToAgent", "manageAgents",
      "teamTask",
      // MCP
      "manageMCP", "useMCP",
      // Project & task tracking
      "projectTracker", "taskManager",
      // Automation
      "cron",
      // Voice & Meetings
      "makeVoiceCall", "meetingAction",
      // Phase 24
      "generateImage", "readPDF", "gitTool", "clipboard",
      "notification", "iMessageTool", "calendar", "contacts",
      "sshTool", "database",
      "googlePlaces", "philipsHue", "sonos",
    ],
  },
};

/**
 * Commands that are ALWAYS blocked regardless of permission tier.
 */
export const blockedCommands = [
  // Destructive file operations
  /rm\s+-rf\s+\//,
  /rm\s+-rf\s+~/,
  /rm\s+-rf\s+\.\s*$/,
  /sudo\s+rm/,
  /rm\s+--no-preserve-root/,
  /mkfs\./,
  /dd\s+if=/,
  // Fork bombs and process attacks
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/,
  // Permission escalation
  /chmod\s+777\s+\//,
  /chmod\s+-R\s+777/,
  /chown.*\/etc/,
  /sudo\s+chmod/,
  /sudo\s+chown/,
  // Device and partition attacks
  />\s*\/dev\/sda/,
  />\s*\/dev\/nvme/,
  // Remote code execution via pipe
  /curl.*\|\s*sh/,
  /wget.*\|\s*sh/,
  /curl.*\|\s*bash/,
  /wget.*\|\s*bash/,
  /curl.*\|\s*python/,
  /wget.*\|\s*python/,
  // System shutdown/reboot
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+0\b/,
  /\bhalt\b/,
  /\bpoweroff\b/,
  // Process killing
  /kill\s+-9\s+1\b/,
  /killall\s+-9/,
  // Sensitive file reads via commands
  /cat\s+.*\/etc\/shadow/,
  /cat\s+.*\.ssh\/id_/,
  /cat\s+.*\.vault\.enc/,
  /cat\s+.*\.env\b/,
  // Environment variable dump (can leak secrets)
  /^\s*env\s*$/,
  /^\s*printenv\s*$/,
  /^\s*set\s*$/,
  // Network attacks
  /\bnmap\b/,
  /\bnetcat\b|\bnc\s+-/,
  // History access (can contain secrets)
  /cat\s+.*\.bash_history/,
  /cat\s+.*\.zsh_history/,
];
