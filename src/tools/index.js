// ─── Tool imports ─────────────────────────────────────────────────────────────
import { executeCommand } from "./executeCommand.js";
import { readFile } from "./readFile.js";
import { writeFile } from "./writeFile.js";
import { editFile } from "./editFile.js";
import { listDirectory } from "./listDirectory.js";
import { searchFiles } from "./searchFiles.js";
import { searchContent } from "./searchContent.js";
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
import { replyWithFile } from "./replyWithFile.js";
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
import { readPDF } from "./readPDF.js";
import { gitTool } from "./gitTool.js";
import { clipboard } from "./clipboard.js";
import { notification } from "./notification.js";
import { iMessageTool } from "./iMessageTool.js";
import { calendar } from "./calendar.js";
import { sshTool } from "./sshTool.js";
import { database } from "./database.js";
import { contacts } from "./contacts.js";
import { googlePlaces } from "./googlePlaces.js";
import { philipsHue } from "./philipsHue.js";
import { sonos } from "./sonos.js";
import { reload } from "./reloadTool.js";

// ─── Agent wrappers (params object → SubAgentManager) ────────────────────────

function spawnAgent(params) {
  const taskDescription = params?.taskDescription;
  // Merge flat fields with legacy options JSON
  const optionsStr = params?.options;
  const legacyOpts = optionsStr ? (typeof optionsStr === "string" ? JSON.parse(optionsStr) : optionsStr) : {};
  const { taskDescription: _, options: _o, ...flatFields } = params || {};
  const options = { ...legacyOpts, ...flatFields };
  return spawnSubAgent(taskDescription, options);
}

function parallelAgents(params) {
  // New schema: tasks is array of objects, sharedContext is flat string
  // Legacy: tasks is JSON string, sharedOptions is JSON string
  const tasksRaw = params?.tasks;
  const tasks = typeof tasksRaw === "string" ? JSON.parse(tasksRaw) : (tasksRaw || []);
  const sharedStr = params?.sharedOptions;
  const legacyShared = sharedStr ? (typeof sharedStr === "string" ? JSON.parse(sharedStr) : sharedStr) : {};
  const sharedOptions = params?.sharedContext ? { ...legacyShared, sharedContext: params.sharedContext } : legacyShared;
  return spawnParallelAgents(tasks, sharedOptions);
}

// ─── Tool Functions Map ──────────────────────────────────────────────────────

export const toolFunctions = {
  readFile, writeFile, editFile, listDirectory,
  searchFiles, searchContent,
  glob: globSearch, grep, applyPatch,
  executeCommand,
  webFetch, webSearch,
  browserAction,
  sendEmail, messageChannel, sendFile, replyWithFile, replyToUser,
  transcribeAudio, textToSpeech,
  createDocument,
  readMemory, writeMemory, readDailyLog, writeDailyLog,
  searchMemory, pruneMemory, listMemoryCategories,
  spawnAgent, parallelAgents, delegateToAgent, manageAgents,
  projectTracker, taskManager,
  cron,
  imageAnalysis, screenCapture,
  manageMCP, useMCP,
  makeVoiceCall,
  teamTask,
  meetingAction,
  generateImage, readPDF,
  gitTool, clipboard, sshTool, database,
  notification, iMessageTool, calendar, contacts,
  googlePlaces, philipsHue, sonos,
  reload,
};
