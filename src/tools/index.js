// ─── Existing tools ────────────────────────────────────────────────────────────
import { executeCommand, executeCommandDescription } from "./executeCommand.js";
import { readFile, readFileDescription } from "./readFile.js";
import { writeFile, writeFileDescription } from "./writeFile.js";
import { editFile, editFileDescription } from "./editFile.js";
import { listDirectory, listDirectoryDescription } from "./listDirectory.js";
import { searchFiles, searchFilesDescription } from "./searchFiles.js";
import { searchContent, searchContentDescription } from "./searchContent.js";
import { webFetch, webFetchDescription } from "./webFetch.js";
import { webSearch, webSearchDescription } from "./webSearch.js";
import { sendEmail, sendEmailDescription } from "./sendEmail.js";
import { createDocument, createDocumentDescription } from "./createDocument.js";
import { browserAction, browserActionDescription } from "./browserAutomation.js";
import {
  readMemory, readMemoryDescription,
  writeMemory, writeMemoryDescription,
  readDailyLog, readDailyLogDescription,
  writeDailyLog, writeDailyLogDescription,
  searchMemory, searchMemoryDescription,
  pruneMemory, pruneMemoryDescription,
  listMemoryCategories, listMemoryCategoriesDescription,
} from "./memory.js";
import { spawnSubAgent, spawnParallelAgents } from "../agents/SubAgentManager.js";
import { delegateToAgent, delegateToAgentDescription } from "../a2a/A2AClient.js";

// ─── Media tools ───────────────────────────────────────────────────────────────
import { transcribeAudio, transcribeAudioDescription } from "./transcribeAudio.js";
import { sendFile, sendFileDescription } from "./sendFile.js";
import { textToSpeech, textToSpeechDescription } from "./textToSpeech.js";

// ─── New tools ─────────────────────────────────────────────────────────────────
import { globSearch, globSearchDescription } from "./glob.js";
import { grep, grepDescription } from "./grep.js";
import { applyPatch, applyPatchDescription } from "./applyPatch.js";
import { imageAnalysis, imageAnalysisDescription } from "./imageAnalysis.js";
import { screenCapture, screenCaptureDescription } from "./screenCapture.js";
import { manageAgents, manageAgentsDescription } from "./manageAgents.js";
import { cron, cronDescription } from "./cronTool.js";
import { messageChannel, messageChannelDescription } from "./messageChannel.js";
import { projectTracker, projectTrackerDescription } from "./projectTracker.js";
import { manageMCP, manageMCPDescription } from "./manageMCP.js";
import { useMCP, useMCPDescription } from "./useMCP.js";
import { makeVoiceCall, makeVoiceCallDescription } from "./makeVoiceCall.js";

// ─── Wrap spawnAgent for the tool interface ────────────────────────────────────
function spawnAgent(taskDescription, optionsJson) {
  const options = optionsJson ? JSON.parse(optionsJson) : {};
  return spawnSubAgent(taskDescription, options);
}

const spawnAgentDescription =
  'spawnAgent(taskDescription: string, optionsJson?: string) - Spawn a sub-agent to handle a task independently. optionsJson: {"model":"openai:gpt-4.1-mini","tools":["readFile","searchContent"],"maxTurns":10,"parentContext":"shared spec here"}';

// ─── Wrap parallelAgents for the tool interface ────────────────────────────────
function parallelAgents(tasksJson, sharedOptionsJson) {
  const tasks         = typeof tasksJson         === "string" ? JSON.parse(tasksJson)         : (tasksJson || []);
  const sharedOptions = typeof sharedOptionsJson === "string" ? JSON.parse(sharedOptionsJson) : (sharedOptionsJson || {});
  return spawnParallelAgents(tasks, sharedOptions);
}

const parallelAgentsDescription =
  `parallelAgents(tasksJson: string, sharedOptionsJson?: string) - Spawn multiple sub-agents in parallel with a shared spec/context.
  CRITICAL: Always pass sharedContext so agents know about each other's work (e.g. HTML class names for CSS agent).
  tasksJson: [{"description":"Write index.html with id=app, class=todo-item"},{"description":"Write style.css for .todo-item"}]
  sharedOptionsJson: {"sharedContext":"Shared spec: HTML uses id=app, ul#todo-list, li.todo-item, button.delete-btn, input#new-todo"}
  Each agent gets the sharedContext as its starting context before its own task description.`;

// ─── Tool Functions Map ────────────────────────────────────────────────────────

export const toolFunctions = {
  // File operations
  readFile,
  writeFile,
  editFile,
  listDirectory,
  searchFiles,
  searchContent,
  // Advanced search (new)
  glob: globSearch,
  grep,
  applyPatch,
  // System
  executeCommand,
  // Web
  webFetch,
  webSearch,
  // Browser
  browserAction,
  // Communication
  sendEmail,
  messageChannel,
  sendFile,
  transcribeAudio,
  textToSpeech,
  // Documents
  createDocument,
  // Memory
  readMemory,
  writeMemory,
  readDailyLog,
  writeDailyLog,
  searchMemory,
  pruneMemory,
  listMemoryCategories,
  // Agents
  spawnAgent,
  parallelAgents,
  delegateToAgent,
  manageAgents,
  // Project tracking
  projectTracker,
  // Automation
  cron,
  // Vision / Screen
  imageAnalysis,
  screenCapture,
  // MCP management
  manageMCP,
  useMCP,
  // Voice
  makeVoiceCall,
};

// ─── Tool Descriptions Array ───────────────────────────────────────────────────

export const toolDescriptions = [
  // File operations
  readFileDescription,
  writeFileDescription,
  editFileDescription,
  listDirectoryDescription,
  searchFilesDescription,
  searchContentDescription,
  // Advanced search
  globSearchDescription,
  grepDescription,
  applyPatchDescription,
  // System
  executeCommandDescription,
  // Web
  webFetchDescription,
  webSearchDescription,
  // Browser
  browserActionDescription,
  // Communication
  sendEmailDescription,
  messageChannelDescription,
  sendFileDescription,
  transcribeAudioDescription,
  textToSpeechDescription,
  // Documents
  createDocumentDescription,
  // Memory
  readMemoryDescription,
  writeMemoryDescription,
  readDailyLogDescription,
  writeDailyLogDescription,
  searchMemoryDescription,
  pruneMemoryDescription,
  listMemoryCategoriesDescription,
  // Agents
  spawnAgentDescription,
  parallelAgentsDescription,
  delegateToAgentDescription,
  manageAgentsDescription,
  // Project tracking
  projectTrackerDescription,
  // Automation
  cronDescription,
  // Vision / Screen
  imageAnalysisDescription,
  screenCaptureDescription,
  // MCP management
  manageMCPDescription,
  useMCPDescription,
  // Voice
  makeVoiceCallDescription,
];
