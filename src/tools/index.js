// ─── Tool imports ─────────────────────────────────────────────────────────────
import { executeCommand } from "./executeCommand.js";
import { readFile } from "./readFile.js";
import { writeFile } from "./writeFile.js";
import { editFile } from "./editFile.js";
import { listDirectory } from "./listDirectory.js";
// searchFiles + searchContent removed - duplicates of glob + grep
import { webFetch } from "./webFetch.js";
import { webSearch } from "./webSearch.js";
import { sendEmail } from "./sendEmail.js";
import { createDocument } from "./createDocument.js";
import { browserAction } from "./browserAutomation.js";
import {
  readMemory, writeMemory,
  readDailyLog, writeDailyLog,
  searchMemory, pruneMemory, listMemoryCategories,
} from "./memory.js";
import { spawnSubAgent, spawnParallelAgents } from "../agents/SubAgentManager.js";
import { delegateToAgent } from "../a2a/A2AClient.js";
import { transcribeAudio } from "./transcribeAudio.js";
import { sendFile } from "./sendFile.js";
// replyWithFile removed - duplicate of sendFile
import { textToSpeech } from "./textToSpeech.js";
import { globSearch } from "./glob.js";
import { grep } from "./grep.js";
import { applyPatch } from "./applyPatch.js";
import { imageAnalysis } from "./imageAnalysis.js";
import { screenCapture } from "./screenCapture.js";
import { manageAgents } from "./manageAgents.js";
import { cron } from "./cronTool.js";
import { messageChannel } from "./messageChannel.js";
import { projectTracker } from "./projectTracker.js";
import { taskManager } from "./taskManager.js";
import { manageMCP } from "./manageMCP.js";
import { useMCP } from "./useMCP.js";
import { makeVoiceCall } from "./makeVoiceCall.js";
import { teamTask } from "./teamTool.js";
import { meetingAction } from "./meetingTool.js";
import { replyToUser } from "./replyToUser.js";
import { generateImage } from "./generateImage.js";
import { generateVideo } from "./generateVideo.js";
import { generateMusic } from "./generateMusic.js";
import { imageOps } from "./imageOps.js";
import { readPDF } from "./readPDF.js";
import { createPoll } from "./pollTool.js";
import { gitTool } from "./gitTool.js";
import { clipboard } from "./clipboard.js";
import {
  desktopClick, desktopMove, desktopType, desktopPressKey, desktopKeyCombo,
  desktopScroll, desktopScreenshot, desktopListWindows, desktopFocusWindow,
  desktopFindElement,
} from "./desktop/index.js";
// Crew tools NOT imported here - crew members are self-contained sub-agents.
// Main agent delegates via useCrew(crewId, task).
import { useCrew } from "./useCrew.js";
import { reload } from "./reloadTool.js";
import { discoverProfiles as discoverCrew } from "./discoverProfiles.js";
import { broadcast } from "./broadcast.js";
import { goal } from "./goalTool.js";
import { watcher } from "./watcherTool.js";

// ─── Crew wrappers (params → SubAgentManager) ────────────────────────────────

function parallelAgents(params) {
  // New schema: tasks is array of objects, sharedContext is flat string
  // Legacy: tasks is JSON string, sharedOptions is JSON string
  const tasksRaw = params?.tasks;
  const rawTasks = typeof tasksRaw === "string" ? JSON.parse(tasksRaw) : (tasksRaw || []);
  // Normalize: schema puts profile/parentContext at top level, spawnParallelAgents expects them inside options
  const tasks = rawTasks.map(t => {
    const { description, profile, parentContext, ...rest } = t;
    return { description, options: { profile, parentContext, ...t.options, ...rest } };
  });
  const sharedStr = params?.sharedOptions;
  const legacyShared = sharedStr ? (typeof sharedStr === "string" ? JSON.parse(sharedStr) : sharedStr) : {};
  const sharedOptions = params?.sharedContext ? { ...legacyShared, sharedContext: params.sharedContext } : legacyShared;
  return spawnParallelAgents(tasks, sharedOptions);
}

// ─── Tool Functions Map ──────────────────────────────────────────────────────

export const toolFunctions = {
  readFile, writeFile, editFile, listDirectory,
  glob: globSearch, grep, applyPatch,
  executeCommand,
  webFetch, webSearch,
  browserAction,
  sendEmail, messageChannel, sendFile, replyToUser,
  transcribeAudio, textToSpeech,
  createDocument,
  readMemory, writeMemory, readDailyLog, writeDailyLog,
  searchMemory, pruneMemory, listMemoryCategories,
  parallelCrew: parallelAgents, delegateToAgent, manageAgents,
  projectTracker, taskManager,
  cron,
  imageAnalysis, screenCapture,
  manageMCP, useMCP, useCrew,
  makeVoiceCall,
  teamTask,
  meetingAction,
  generateImage, generateVideo, generateMusic, imageOps, readPDF, createPoll,
  gitTool, clipboard,
  desktopScreenshot, desktopListWindows, desktopFocusWindow, desktopFindElement,
  desktopClick, desktopMove, desktopType, desktopPressKey, desktopKeyCombo, desktopScroll,
  discoverCrew,
  broadcast,
  goal,
  watcher,
  reload,
};

// mergePluginTools() removed - crew members are self-contained sub-agents.
// Crew tools stay in PluginRegistry, accessed via CrewAgentRunner.
